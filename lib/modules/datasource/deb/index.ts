import { createHash } from 'crypto';
import readline from 'readline';
import { createUnzip } from 'zlib';
import upath from 'upath';
import { logger } from '../../../logger';
import { cache } from '../../../util/cache/package/decorator';
import * as fs from '../../../util/fs';
import type { HttpOptions } from '../../../util/http/types';
import { joinUrlParts } from '../../../util/url';
import { Datasource } from '../datasource';
import type { GetReleasesConfig, ReleaseResult } from '../types';
import type { PackageDescription } from './types';

export class DebDatasource extends Datasource {
  static readonly id = 'deb';

  constructor() {
    super(DebDatasource.id);
  }

  /**
   * This is just an internal list of compressions that are supported and tried to be downloaded from the remote
   */
  static readonly compressions = ['gz'];

  /**
   * This specifies the directory where the extracted and downloaded packages files are stored relative to cacheDir.
   * The folder will be created automatically if it doesn't exist.
   */
  static readonly cacheSubDir: string = 'deb';

  /**
   * Users are able to specify custom Debian repositories as long as they follow
   * the Debian package repository format as specified here
   * @see{https://wiki.debian.org/DebianRepository/Format}
   */
  override readonly customRegistrySupport = true;

  /**
   * The original apt source list file format is
   * deb uri distribution [component1] [component2] [...]
   * @see{https://wiki.debian.org/DebianRepository/Format}
   *
   * However, for Renovate, we require the registry URLs to be
   * valid URLs which is why the parameters are encoded in the URL.
   *
   * The following query parameters are required:
   * - components: comma separated list of components
   * - suite: stable, oldstable or other alias for a release, either this or release must be given
   * - release: buster, etc.
   * - binaryArch: e.g. amd64 resolves to http://ftp.debian.org/debian/dists/stable/non-free/binary-amd64/
   */
  override readonly defaultRegistryUrls = [
    'https://ftp.debian.org/debian?suite=stable&components=main,contrib,non-free&binaryArch=amd64',
  ];

  override readonly caching = true;

  /**
   * Not all Debian packages follow Semver, so it's wise to keep this loose but make sure to
   * have enough tests in your application.
   */
  override readonly defaultVersioning = 'deb';

  static requiredPackageKeys: Array<keyof PackageDescription> = [
    'Package',
    'Version',
    'Homepage',
  ];

  /**
   * Extracts the specified compressed file to the output file.
   *
   * @param compressedFile - The path to the compressed file.
   * @param compression - The compression method used (currently only 'gz' is supported).
   * @param outputFile - The path where the extracted content will be stored.
   * @throws Will throw an error if the compression method is unknown.
   */
  static async extract(
    compressedFile: string,
    compression: string,
    outputFile: string,
  ): Promise<void> {
    if (compression === 'gz') {
      const source = fs.createCacheReadStream(compressedFile);
      const destination = fs.createCacheWriteStream(outputFile);
      await fs.pipeline(source, createUnzip(), destination);
    } else {
      throw new Error(`Unsupported compression standard '${compression}'`);
    }
  }

  /**
   * Checks if the file exists and retrieves its creation time.
   *
   * @param filePath - The path to the file.
   * @returns The creation time if the file exists, otherwise undefined.
   */
  async getFileCreationTime(filePath: string): Promise<Date | undefined> {
    const stats = await fs.statCacheFile(filePath);
    return stats?.ctime;
  }

  /**
   * Downloads and extracts a package file from a component URL.
   *
   * @param componentUrl - The URL of the component.
   * @returns The path to the extracted file and the last modification timestamp.
   * @throws Will throw an error if no valid compression method is found.
   */
  async downloadAndExtractPackage(
    componentUrl: string,
  ): Promise<{ extractedFile: string; lastTimestamp: Date }> {
    const packageUrlHash = createHash('sha256')
      .update(componentUrl)
      .digest('hex');
    const fullCacheDir = await fs.ensureCacheDir(DebDatasource.cacheSubDir);
    const extractedFile = upath.join(fullCacheDir, `${packageUrlHash}.txt`);
    let lastTimestamp = await this.getFileCreationTime(extractedFile);

    for (const compression of DebDatasource.compressions) {
      const compressedFile = upath.join(
        fullCacheDir,
        `${packageUrlHash}.${compression}`,
      );

      const wasUpdated = await this.downloadPackageFile(
        componentUrl,
        compression,
        compressedFile,
        lastTimestamp,
      );
      if (wasUpdated || !lastTimestamp) {
        try {
          await DebDatasource.extract(
            compressedFile,
            compression,
            extractedFile,
          );
          lastTimestamp = await this.getFileCreationTime(extractedFile);
        } catch (error) {
          logger.error(
            {
              componentUrl,
              compression,
              error: error.message,
            },
            `Failed to extract package file from ${compressedFile}`,
          );
        } finally {
          await fs.rmCache(compressedFile);
        }
      }

      if (!lastTimestamp) {
        //extracting went wrong
        break;
      }

      return { extractedFile, lastTimestamp };
    }

    throw new Error(`No compression standard worked for ${componentUrl}`);
  }

  /**
   * Downloads a package file if it has been modified since the last download timestamp.
   *
   * @param basePackageUrl - The base URL of the package.
   * @param compression - The compression method used (e.g., 'gz').
   * @param compressedFile - The path where the compressed file will be saved.
   * @param lastDownloadTimestamp - The timestamp of the last download.
   * @returns True if the file was downloaded, otherwise false.
   */
  async downloadPackageFile(
    basePackageUrl: string,
    compression: string,
    compressedFile: string,
    lastDownloadTimestamp?: Date,
  ): Promise<boolean> {
    const packageUrl = `${basePackageUrl}/Packages.${compression}`;
    let needsToDownload = true;

    if (lastDownloadTimestamp) {
      needsToDownload = await this.checkIfModified(
        packageUrl,
        lastDownloadTimestamp,
      );
    }

    if (needsToDownload) {
      try {
        const readStream = this.http.stream(packageUrl);
        const writeStream = fs.createCacheWriteStream(compressedFile);
        await fs.pipeline(readStream, writeStream);
        logger.debug(
          { url: packageUrl, targetFile: compressedFile },
          'Downloading Debian package file',
        );
      } catch (error) {
        logger.error(
          `Failed to download package file from ${packageUrl}: ${error.message}`,
        );
        needsToDownload = false;
      }
    } else {
      logger.debug(`No need to download ${packageUrl}, file is up to date.`);
    }

    return needsToDownload;
  }

  /**
   * Checks if a packageUrl content has been modified since the specified timestamp.
   *
   * @param packageUrl - The URL to check.
   * @param lastDownloadTimestamp - The timestamp of the last download.
   * @returns True if the content has been modified, otherwise false.
   * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-Modified-Since
   */
  async checkIfModified(
    packageUrl: string,
    lastDownloadTimestamp: Date,
  ): Promise<boolean> {
    const options: HttpOptions = {
      headers: {
        'If-Modified-Since': lastDownloadTimestamp.toUTCString(),
      },
    };

    try {
      const response = await this.http.head(packageUrl, options);
      return response.statusCode !== 304;
    } catch (error) {
      logger.warn(
        `Could not determine if ${packageUrl} is modified since ${lastDownloadTimestamp.toUTCString()}: ${error.message}`,
      );
      return true; // Assume it needs to be downloaded if check fails
    }
  }

  /**
   * Parses the extracted package file to find the specified package.
   *
   * @param extractedFile - The path to the extracted package file.
   * @param packageName - The name of the package to find.
   * @param lastTimestamp - The timestamp of the last modification.
   * @returns The release result if found, otherwise null.
   */
  @cache({
    namespace: `datasource-${DebDatasource.id}-package`,
    key: (extractedFile: string, packageName: string, lastTimestamp: Date) =>
      `${extractedFile}:${packageName}:${lastTimestamp.getTime()}`,
    ttlMinutes: 24 * 60,
  })
  async parseExtractedPackage(
    extractedFile: string,
    packageName: string,
    lastTimestamp: Date,
  ): Promise<ReleaseResult | null> {
    // read line by line to avoid high memory consumption as the extracted Packages
    // files can be multiple MBs in size
    const rl = readline.createInterface({
      input: fs.createCacheReadStream(extractedFile),
      terminal: false,
    });

    let currentPackage: PackageDescription = {};

    for await (const line of rl) {
      if (line === '') {
        // All information of the package are available, early return possible
        if (currentPackage.Package === packageName) {
          return this.formatReleaseResult(currentPackage);
        }
        currentPackage = {};
      } else {
        for (const key of DebDatasource.requiredPackageKeys) {
          if (line.startsWith(`${key}:`)) {
            currentPackage[key] = line.substring(key.length + 1).trim();
            break;
          }
        }
      }
    }

    // Check the last package after file reading is complete
    if (currentPackage.Package === packageName) {
      return this.formatReleaseResult(currentPackage);
    }

    return null;
  }

  /**
   * Formats the package description into a ReleaseResult.
   *
   * @param packageDesc - The package description object.
   * @returns A formatted ReleaseResult.
   */
  formatReleaseResult(packageDesc: PackageDescription): ReleaseResult {
    return {
      releases: [{ version: packageDesc.Version! }],
      homepage: packageDesc.Homepage,
    };
  }

  /**
   * Constructs the component URLs from the given registry URL.
   *
   * @param registryUrl - The base URL of the registry.
   * @returns An array of component URLs.
   * @throws Will throw an error if required parameters are missing from the URL.
   */
  constructComponentUrls(registryUrl: string): string[] {
    const REQUIRED_PARAMS = ['components', 'binaryArch'];
    const OPTIONAL_PARAMS = ['release', 'suite'];

    const validateUrlAndParams = (url: URL): void => {
      REQUIRED_PARAMS.forEach((param) => {
        if (!url.searchParams.has(param)) {
          throw new Error(`Missing required query parameter '${param}'`);
        }
      });
    };

    const getReleaseParam = (url: URL): string => {
      for (const param of OPTIONAL_PARAMS) {
        const paramValue = url.searchParams.get(param);
        if (paramValue !== null) {
          return paramValue;
        }
      }
      throw new Error(
        `Missing one of ${OPTIONAL_PARAMS.join(', ')} query parameter`,
      );
    };

    try {
      const url = new URL(registryUrl);
      validateUrlAndParams(url);

      const release = getReleaseParam(url);
      const binaryArch = url.searchParams.get('binaryArch');
      const components = url.searchParams.get('components')!.split(',');

      // Clean up URL search parameters for constructing new URLs
      [...REQUIRED_PARAMS, ...OPTIONAL_PARAMS].forEach((param) =>
        url.searchParams.delete(param),
      );

      return components.map((component) => {
        return joinUrlParts(
          url.toString(),
          `dists`,
          release,
          component,
          `binary-${binaryArch}`,
        );
      });
    } catch (error) {
      throw new Error(
        `Invalid deb repo URL: ${registryUrl} - see documentation: ${error.message}`,
      );
    }
  }

  /**
   * Fetches the release information for a given package from the registry URL.
   *
   * @param config - Configuration for fetching releases.
   * @returns The release result if the package is found, otherwise null.
   */
  async getReleases({
    registryUrl,
    packageName,
  }: GetReleasesConfig): Promise<ReleaseResult | null> {
    // istanbul ignore if
    if (!registryUrl) {
      return null;
    }

    const componentUrls = this.constructComponentUrls(registryUrl);
    let aggregatedRelease: ReleaseResult | null = null;

    for (const componentUrl of componentUrls) {
      try {
        const { extractedFile, lastTimestamp } =
          await this.downloadAndExtractPackage(componentUrl);
        const newRelease = await this.parseExtractedPackage(
          extractedFile,
          packageName,
          lastTimestamp,
        );

        if (newRelease) {
          if (aggregatedRelease === null) {
            aggregatedRelease = newRelease;
          } else {
            if (
              !this.releaseMetaInformationMatches(aggregatedRelease, newRelease)
            ) {
              logger.warn(
                { packageName },
                'Package occurred in more than one repository with different meta information. Aggregating releases anyway.',
              );
            }
            aggregatedRelease.releases.push(...newRelease.releases);
          }
        }
      } catch (error) {
        logger.warn(
          { componentUrl, error },
          'Skipping component due to an error',
        );
      }
    }

    return aggregatedRelease;
  }

  /**
   * Checks if two release metadata objects match.
   *
   * @param lhs - The first release result.
   * @param rhs - The second release result.
   * @returns True if the metadata matches, otherwise false.
   */
  releaseMetaInformationMatches(
    lhs: ReleaseResult,
    rhs: ReleaseResult,
  ): boolean {
    return lhs.homepage === rhs.homepage;
  }
}
