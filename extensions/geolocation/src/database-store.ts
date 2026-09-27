/**
 * Owns the on-disk MMDB copy: downloads it on first use, reuses it until it
 * ages past the refresh window, and keeps one opened reader per process.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { type CityResponse, Reader } from "maxmind";
import { tempFile } from "openclaw/plugin-sdk/file-access-runtime";
import { readByteStreamWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { expandDatabaseUrls, type GeolocationSettings } from "./config.js";

const gunzipAsync = promisify(gunzip);

// A city-level MMDB is ~125 MB today and its gzip is ~20 MB. Both ceilings are
// enforced while reading, not after: a replaced or compromised source must not
// be able to allocate an unbounded body, and a compression bomb must not be able
// to inflate past the on-disk ceiling either.
const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** The database's own record contract; re-exported so callers need one import. */
export type GeolocationCityRecord = CityResponse;

export type GeolocationDatabase = {
  lookup: (ip: string) => GeolocationCityRecord | null;
};

type StoreDeps = {
  stateDir: string;
  settings: GeolocationSettings;
  now: () => Date;
  fetchImpl: typeof fetch;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
};

function databasePath(stateDir: string, databaseUrl: string): string {
  // The URL is part of the name so switching sources cannot silently reuse the
  // previous provider's data under the new provider's attribution.
  const digest = createHash("sha256").update(databaseUrl).digest("hex").slice(0, 12);
  return path.join(stateDir, "geolocation", `ip-city-${digest}.mmdb`);
}

async function readFileAge(file: string, now: Date): Promise<number | undefined> {
  try {
    const stat = await fs.stat(file);
    return now.getTime() - stat.mtimeMs;
  } catch {
    return undefined;
  }
}

async function downloadDatabase(deps: StoreDeps, target: string): Promise<Reader<CityResponse>> {
  const urls = expandDatabaseUrls(deps.settings.databaseUrl, deps.now());
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const response = await deps.fetchImpl(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        failures.push(`${url} -> HTTP ${response.status}`);
        continue;
      }
      if (!response.body) {
        throw new Error("response had no body");
      }
      const raw = await readByteStreamWithLimit(response.body.values(), {
        maxBytes: MAX_COMPRESSED_BYTES,
        onOverflow: ({ maxBytes }) => new Error(`response exceeded the ${maxBytes} byte cap`),
      });
      // maxOutputLength makes zlib stop inflating at the ceiling rather than
      // allocating whatever the compressed stream claims to expand into.
      const body = url.endsWith(".gz")
        ? await gunzipAsync(raw, { maxOutputLength: MAX_DATABASE_BYTES })
        : raw;
      // Parse before publishing so a truncated or HTML error body never replaces
      // a working database on disk. The reader is returned so the caller does
      // not read and parse the same bytes a second time.
      const reader = new Reader<CityResponse>(body);
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const directory = await fs.realpath(path.dirname(target));
        await using staged = await tempFile({
          rootDir: directory,
          prefix: "ip-city",
          onCleanupError: (error) => {
            throw error;
          },
        });
        await fs.writeFile(staged.path, body, { flag: "wx" });
        await fs.rename(staged.path, path.join(directory, path.basename(target)));
      } catch (err) {
        deps.logger?.warn(
          `geolocation: could not cache the downloaded database, serving it from memory: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      deps.logger?.info(`geolocation: downloaded ${body.byteLength} bytes from ${url}`);
      return reader;
    } catch (err) {
      failures.push(`${url} -> ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`geolocation database download failed: ${failures.join("; ")}`);
}

/**
 * Returns a reader, downloading or refreshing the database as needed. A stale
 * copy is preferred over failing: a refresh error must not take lookups down.
 */
export function createGeolocationDatabaseStore(deps: StoreDeps) {
  const target = databasePath(deps.stateDir, deps.settings.databaseUrl);
  let opened: { reader: Reader<CityResponse>; loadedAt: number } | undefined;
  let inFlight: Promise<GeolocationDatabase> | undefined;

  const openFromDisk = async (): Promise<GeolocationDatabase> => {
    const age = await readFileAge(target, deps.now());
    let downloaded: Reader<CityResponse> | undefined;
    if (age === undefined) {
      downloaded = await downloadDatabase(deps, target);
    } else if (age > deps.settings.refreshMs) {
      try {
        downloaded = await downloadDatabase(deps, target);
      } catch (err) {
        // A refresh failure must not take lookups down; the cached copy is old
        // but still answers.
        deps.logger?.warn(
          `geolocation: refresh failed, serving the cached database: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const reader = downloaded ?? new Reader<CityResponse>(await fs.readFile(target));
    opened = { reader, loadedAt: deps.now().getTime() };
    return { lookup: (ip: string) => reader.get(ip) };
  };

  return {
    async load(): Promise<GeolocationDatabase> {
      const current = opened;
      if (current && deps.now().getTime() - current.loadedAt <= deps.settings.refreshMs) {
        return { lookup: (ip: string) => current.reader.get(ip) };
      }
      // One download at a time: concurrent first lookups must not each fetch.
      inFlight ??= openFromDisk().finally(() => {
        inFlight = undefined;
      });
      return await inFlight;
    },
    databaseFile: target,
  };
}
