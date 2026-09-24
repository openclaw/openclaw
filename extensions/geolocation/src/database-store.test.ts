import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGeolocationSettings } from "./config.js";
import { createGeolocationDatabaseStore } from "./database-store.js";

const created: string[] = [];
const now = new Date("2026-01-03T00:00:00Z");

async function tempStateDir(): Promise<string> {
  // Realpath first: macOS tmp is a symlink and the store compares resolved paths.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geolocation-store-")));
  created.push(dir);
  return dir;
}

function jsonResponse(body: Buffer, ok = true): Response {
  return new Response(Uint8Array.from(body), { status: ok ? 200 : 404 });
}

function chunkedResponse(
  chunkBytes: number,
  chunkCount: number,
  cancel?: () => Promise<void>,
): Response {
  let emitted = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (emitted >= chunkCount) {
            controller.close();
            return;
          }
          emitted += 1;
          controller.enqueue(new Uint8Array(chunkBytes));
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("geolocation database store", () => {
  it("tries the previous month when the current build is not published yet", async () => {
    const stateDir = await tempStateDir();
    const fetchImpl = vi.fn(async () => jsonResponse(Buffer.from("nope"), false));
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({
        databaseUrl: "https://host.test/db-{yyyy}-{mm}.mmdb",
      }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(store.load()).rejects.toThrow(/db-2026-01.*db-2025-12/s);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses to publish an unparsable body, leaving no database behind", async () => {
    const stateDir = await tempStateDir();
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb" }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: (async () =>
        jsonResponse(Buffer.from("<html>rate limited</html>"))) as unknown as typeof fetch,
    });

    await expect(store.load()).rejects.toThrow(/db\.mmdb/);
    await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
  });

  it("downloads once when concurrent callers race the first lookup", async () => {
    const stateDir = await tempStateDir();
    const fetchImpl = vi.fn(async () => jsonResponse(Buffer.from("garbage")));
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb" }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const results = await Promise.allSettled([store.load(), store.load(), store.load()]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("names the source in the cache path so a swapped source cannot reuse the old data", async () => {
    const stateDir = await tempStateDir();
    const settingsFor = (databaseUrl: string) =>
      createGeolocationDatabaseStore({
        stateDir,
        settings: resolveGeolocationSettings({ databaseUrl }),
        now: () => new Date("2026-01-03T00:00:00Z"),
        fetchImpl: (async () => jsonResponse(Buffer.from(""))) as unknown as typeof fetch,
      }).databaseFile;

    expect(settingsFor("https://a.test/db.mmdb")).not.toBe(settingsFor("https://b.test/db.mmdb"));
  });

  it("rejects an oversized body after its source cancellation settles", async () => {
    const stateDir = await tempStateDir();
    // 3 chunks of 128 MiB exceeds the 256 MiB compressed ceiling on the third
    // read, so the reader must stop rather than buffer the whole response.
    const chunkBytes = 128 * 1024 * 1024;
    const cancellationStarted = createDeferred<void>();
    const finishCancellation = createDeferred<void>();
    let cancellationFinished = false;
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb" }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: async () =>
        chunkedResponse(chunkBytes, 3, async () => {
          cancellationStarted.resolve();
          await finishCancellation.promise;
          cancellationFinished = true;
          throw new Error("synthetic cancellation failure");
        }),
    });

    const loading = store.load();
    let settled = false;
    const observed = loading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([cancellationStarted.promise, observed]);
      expect(settled).toBe(false);
    } finally {
      finishCancellation.resolve();
    }
    await expect(loading).rejects.toThrow(/exceeded the \d+ byte cap/);
    await observed;
    expect(cancellationFinished).toBe(true);
    await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
  });

  it("refuses a gzip source that inflates past the on-disk ceiling", async () => {
    const stateDir = await tempStateDir();
    // A highly compressible payload stands in for a compression bomb: the
    // compressed bytes are tiny, the inflated output is what must be bounded.
    const inflated = Buffer.alloc(700 * 1024 * 1024, 0);
    const compressed = gzipSync(inflated);
    const store = createGeolocationDatabaseStore({
      stateDir,
      settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb.gz" }),
      now: () => new Date("2026-01-03T00:00:00Z"),
      fetchImpl: (async () => jsonResponse(compressed)) as unknown as typeof fetch,
    });

    await expect(store.load()).rejects.toThrow(/db\.mmdb\.gz/);
    await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
  });
});

function cityDatabase(city: string): Buffer {
  const text = (value: string) =>
    Buffer.concat([Buffer.from([0x40 + Buffer.byteLength(value)]), Buffer.from(value)]);
  // One IPv4 node points both branches at the same synthetic city record.
  return Buffer.concat([
    Buffer.from([0, 0, 17, 0, 0, 17]),
    Buffer.alloc(16),
    Buffer.from([0xe1]),
    text("city"),
    Buffer.from([0xe1]),
    text("names"),
    Buffer.from([0xe1]),
    text("en"),
    text(city),
    Buffer.from("abcdef4d61784d696e642e636f6d", "hex"),
    Buffer.from([0xe7]),
    text("node_count"),
    Buffer.from([0xc1, 1]),
    text("record_size"),
    Buffer.from([0xa1, 24]),
    text("ip_version"),
    Buffer.from([0xa1, 4]),
    text("binary_format_major_version"),
    Buffer.from([0xa1, 2]),
    text("binary_format_minor_version"),
    Buffer.from([0xa0]),
    text("build_epoch"),
    Buffer.from([0xc1, 1]),
    text("database_type"),
    text("synthetic-city"),
  ]);
}

function createStore(
  stateDir: string,
  body: Buffer,
  downloaded?: () => Promise<void>,
  warn?: (message: string) => void,
) {
  return createGeolocationDatabaseStore({
    stateDir,
    settings: resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb" }),
    now: () => now,
    logger: warn ? { info: () => {}, warn } : undefined,
    fetchImpl: async () => {
      await downloaded?.();
      return new Response(Uint8Array.from(body));
    },
  });
}

describe("geolocation database publication", () => {
  it.each(["before", "after"] as const)(
    "serves its download when another process publishes %s its rename",
    async (publication) => {
      const stateDir = await tempStateDir();
      const body = cityDatabase("Vienna");
      const competingBody = cityDatabase("Paris");
      const warn = vi.fn();
      const store = createStore(stateDir, body, undefined, warn);
      const rename = fs.rename;
      let competingPublished = false;
      vi.spyOn(fs, "rename").mockImplementationOnce(async (source, target) => {
        const publishCompeting = async () => {
          const oldStaging = `${store.databaseFile}.partial`;
          await fs.writeFile(oldStaging, competingBody);
          await rename(oldStaging, store.databaseFile);
          competingPublished = true;
        };
        if (publication === "before") {
          await publishCompeting();
        }
        await rename(source, target);
        if (publication === "after") {
          await publishCompeting();
        }
      });

      const database = await store.load();

      expect(competingPublished).toBe(true);
      expect(database.lookup("8.8.8.8")?.city?.names.en).toBe("Vienna");
      expect(await fs.readFile(store.databaseFile)).toEqual(
        publication === "before" ? body : competingBody,
      );
      expect(warn).not.toHaveBeenCalled();
      expect(await fs.readdir(path.dirname(store.databaseFile))).toEqual([
        path.basename(store.databaseFile),
      ]);
    },
  );

  it("keeps the first download invisible while its staged file is being written", async () => {
    const stateDir = await tempStateDir();
    const firstBody = cityDatabase("Vienna");
    const firstStore = createStore(stateDir, firstBody);
    const secondDownloaded = vi.fn();
    const secondStore = createStore(stateDir, cityDatabase("Paris"), secondDownloaded);
    const beforeWrite = createDeferred<void>();
    const finishWrite = createDeferred<void>();
    let firstWrite = true;
    const pauseFirstWrite = async () => {
      if (firstWrite) {
        firstWrite = false;
        beforeWrite.resolve();
        await finishWrite.promise;
      }
    };
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (
        typeof flags === "number" &&
        (flags & constants.O_CREAT) !== 0 &&
        String(file) !== firstStore.databaseFile
      ) {
        await pauseFirstWrite();
      }
      return await open(file, flags, mode);
    });
    const writeFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      await pauseFirstWrite();
      return await writeFile(file, data, options);
    });

    const nativeMode = getFsSafeNativeConfig().mode;
    configureFsSafeNative({ mode: "off" });
    const firstLoading = firstStore.load();
    try {
      await Promise.race([beforeWrite.promise, firstLoading]);
      expect(firstWrite).toBe(false);
      await expect(fs.stat(firstStore.databaseFile)).rejects.toMatchObject({ code: "ENOENT" });
      const secondDatabase = await secondStore.load();
      expect(secondDatabase.lookup("8.8.8.8")?.city?.names.en).toBe("Paris");
      expect(secondDownloaded).toHaveBeenCalledOnce();
    } finally {
      finishWrite.resolve();
      try {
        await firstLoading;
      } finally {
        configureFsSafeNative({ mode: nativeMode });
      }
    }

    expect((await firstLoading).lookup("8.8.8.8")?.city?.names.en).toBe("Vienna");
    expect(await fs.readFile(firstStore.databaseFile)).toEqual(firstBody);
    expect(await fs.readdir(path.dirname(firstStore.databaseFile))).toEqual([
      path.basename(firstStore.databaseFile),
    ]);
  });

  it.each(["staging", "publication", "download", "parse"] as const)(
    "preserves the disk cache when %s fails",
    async (failure) => {
      const stateDir = await tempStateDir();
      const oldBody = cityDatabase("Vienna");
      const warn = vi.fn();
      const store = createStore(
        stateDir,
        failure === "parse" ? Buffer.from("invalid MMDB") : cityDatabase("Paris"),
        async () => {
          if (failure === "download") {
            throw new Error("synthetic download failure");
          }
        },
        warn,
      );
      const directory = path.dirname(store.databaseFile);
      await fs.mkdir(directory);
      await fs.writeFile(store.databaseFile, oldBody);
      await fs.utimes(store.databaseFile, 0, 0);
      if (failure === "publication") {
        vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("synthetic publication failure"));
      } else if (failure === "staging") {
        const writeFile = fs.writeFile;
        vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file, _data, options) => {
          await writeFile(file, cityDatabase("Paris").subarray(0, 10), options);
          throw new Error("synthetic partial write failure");
        });
      }

      const database = await store.load();

      expect(database.lookup("8.8.8.8")?.city?.names.en).toBe(
        failure === "publication" || failure === "staging" ? "Paris" : "Vienna",
      );
      expect(await fs.readFile(store.databaseFile)).toEqual(oldBody);
      expect(await fs.readdir(directory)).toEqual([path.basename(store.databaseFile)]);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it("publishes overlapping stores with their own readers through a symlinked cache", async () => {
    const stateDir = await tempStateDir();
    const directory = path.join(stateDir, "geolocation");
    const storage = path.join(stateDir, "cache");
    await fs.mkdir(storage, { mode: 0o750 });
    await fs.symlink(storage, directory, process.platform === "win32" ? "junction" : "dir");
    const bothFetching = createDeferred<void>();
    let downloads = 0;
    const downloaded = async () => {
      downloads += 1;
      if (downloads === 2) {
        bothFetching.resolve();
      }
      await bothFetching.promise;
    };
    const firstBody = cityDatabase("Vienna");
    const secondBody = cityDatabase("Paris");
    const firstStore = createStore(stateDir, firstBody, downloaded);
    const stores = [firstStore, createStore(stateDir, secondBody, downloaded)];

    const databases = await Promise.allSettled(stores.map((store) => store.load()));

    expect(
      databases.map((database) =>
        database.status === "fulfilled"
          ? database.value.lookup("8.8.8.8")?.city?.names.en
          : database.reason,
      ),
    ).toEqual(["Vienna", "Paris"]);
    const target = firstStore.databaseFile;
    const published = await fs.readFile(target);
    expect(firstBody.equals(published) || secondBody.equals(published)).toBe(true);
    expect(await fs.readdir(storage)).toEqual([path.basename(target)]);
    if (process.platform !== "win32") {
      expect((await fs.stat(target)).mode & 0o777).toBe(0o666 & ~process.umask());
      expect((await fs.stat(storage)).mode & 0o777).toBe(0o750 & ~process.umask());
    }
    expect((await firstStore.load()).lookup("8.8.8.8")?.city?.names.en).toBe("Vienna");
    expect(downloads).toBe(2);
  });
});
