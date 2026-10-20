import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGeolocationSettings } from "./config.js";
import { createGeolocationDatabaseStore } from "./database-store.js";

const now = new Date("2026-01-03T00:00:00Z");
let stateDir: string;
let currentTime: Date;

beforeEach(async () => {
  currentTime = now;
  // Realpath first: macOS tmp is a symlink and the store compares resolved paths.
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geolocation-store-")));
});

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("geolocation database store", () => {
  it("tries the previous month when the current build is not published yet", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(Buffer.from("nope"), false));
    const store = createStore(fetchImpl, {
      databaseUrl: "https://host.test/db-{yyyy}-{mm}.mmdb",
    });

    await expect(store.load()).rejects.toThrow(/db-2026-01.*db-2025-12/s);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://host.test/db-2026-01.mmdb",
      "https://host.test/db-2025-12.mmdb",
    ]);
  });

  it("downloads once when concurrent callers race the first lookup", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(Buffer.from("garbage")));
    const store = createStore(fetchImpl);

    const results = await Promise.allSettled([store.load(), store.load(), store.load()]);

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
  });

  it("rejects an oversized body after its source cancellation settles", async () => {
    // 3 chunks of 128 MiB exceeds the 256 MiB compressed ceiling on the third
    // read, so the reader must stop rather than buffer the whole response.
    const chunkBytes = 128 * 1024 * 1024;
    const cancellationStarted = createDeferred<void>();
    const finishCancellation = createDeferred<void>();
    let cancellationFinished = false;
    const store = createStore(async () =>
      chunkedResponse(chunkBytes, 3, async () => {
        cancellationStarted.resolve();
        await finishCancellation.promise;
        cancellationFinished = true;
        throw new Error("synthetic cancellation failure");
      }),
    );

    const loading = store.load();
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    const observed = loading.then(markSettled, markSettled);
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
    // A highly compressible payload stands in for a compression bomb: the
    // compressed bytes are tiny, the inflated output is what must be bounded.
    const compressed = gzipSync(Buffer.alloc(700 * 1024 * 1024, 0));
    const store = createStore(compressed, {
      databaseUrl: "https://host.test/db.mmdb.gz",
    });

    await expect(store.load()).rejects.toThrow(/db\.mmdb\.gz/);
    await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
  });
});

function cityDatabase(city: string): Buffer {
  const text = (value: string) =>
    Buffer.concat([Buffer.from([0x40 + Buffer.byteLength(value)]), Buffer.from(value)]);
  const field = (key: string, bytes: number[]) => Buffer.concat([text(key), Buffer.from(bytes)]);
  // One IPv4 node points both branches at the same synthetic city record.
  return Buffer.concat([
    Buffer.from([0, 0, 17, 0, 0, 17]),
    Buffer.alloc(16),
    ...["city", "names", "en"].flatMap((key) => [Buffer.from([0xe1]), text(key)]),
    text(city),
    Buffer.from("abcdef4d61784d696e642e636f6de7", "hex"),
    field("node_count", [0xc1, 1]),
    field("record_size", [0xa1, 24]),
    field("ip_version", [0xa1, 4]),
    field("binary_format_major_version", [0xa1, 2]),
    field("binary_format_minor_version", [0xa0]),
    field("build_epoch", [0xc1, 1]),
    text("database_type"),
    text("synthetic-city"),
  ]);
}

function createStore(
  body: Buffer | typeof fetch,
  options: {
    databaseUrl?: string;
    downloaded?: () => Promise<void>;
    warn?: (message: string) => void;
  } = {},
) {
  const databaseUrl = options.databaseUrl ?? "https://host.test/db.mmdb";
  const store = createGeolocationDatabaseStore({
    stateDir,
    settings: resolveGeolocationSettings({ databaseUrl }),
    now: () => currentTime,
    logger: options.warn ? { info: () => {}, warn: options.warn } : undefined,
    fetchImpl:
      typeof body === "function"
        ? body
        : async () => {
            await options.downloaded?.();
            return jsonResponse(body);
          },
  });
  const digest = createHash("sha256").update(databaseUrl).digest("hex").slice(0, 12);
  return { ...store, databaseFile: path.join(stateDir, "geolocation", `ip-city-${digest}.mmdb`) };
}

type Store = ReturnType<typeof createStore>;
const cityOf = (database: Awaited<ReturnType<Store["load"]>>) =>
  database.lookup("8.8.8.8")?.city?.names.en;
async function seedCache(store: Store, body: Buffer) {
  await fs.mkdir(path.dirname(store.databaseFile));
  await fs.writeFile(store.databaseFile, body);
  await fs.utimes(store.databaseFile, 0, 0);
}
async function expectPublished(store: Store, body: Buffer) {
  expect(await fs.readFile(store.databaseFile)).toEqual(body);
  expect(await fs.readdir(path.dirname(store.databaseFile))).toEqual([
    path.basename(store.databaseFile),
  ]);
}

describe("geolocation database publication", () => {
  it("releases an idle disk-backed reader and reopens it without downloading", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(cityDatabase("Vienna")));
    const store = createStore(fetchImpl);
    const readFile = vi.spyOn(fs, "readFile");

    expect(cityOf(await store.load())).toBe("Vienna");
    await vi.advanceTimersByTimeAsync(45_000);
    const active = await store.load();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(cityOf(await store.load())).toBe("Vienna");
    expect(readFile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    const reopened = await Promise.all([store.load(), store.load()]);
    expect(reopened.map(cityOf)).toEqual(["Vienna", "Vienna"]);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    // An in-progress request may still own the old reader after idle eviction.
    expect(cityOf(active)).toBe("Vienna");
  });

  it("retains an unpublished download when idle so a cache failure cannot lose it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(cityDatabase("Vienna")))
      .mockRejectedValue(new Error("source unavailable"));
    const store = createStore(fetchImpl);
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));

    expect(cityOf(await store.load())).toBe("Vienna");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cityOf(await store.load())).toBe("Vienna");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves failed-refresh backoff across idle reopens without extending it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("source unavailable"));
    const settings = resolveGeolocationSettings({ databaseUrl: "https://host.test/db.mmdb" });
    const store = createStore(fetchImpl);
    await seedCache(store, cityDatabase("Vienna"));

    expect(cityOf(await store.load())).toBe("Vienna");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    currentTime = new Date(now.getTime() + 60_000);
    expect(cityOf(await store.load())).toBe("Vienna");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(settings.refreshMs);
    currentTime = new Date(now.getTime() + settings.refreshMs + 1);
    expect(cityOf(await store.load())).toBe("Vienna");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves its own reader after another process replaces its publication", async () => {
    const body = cityDatabase("Vienna");
    const competingBody = cityDatabase("Paris");
    const warn = vi.fn();
    const store = createStore(body, { warn });
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementationOnce(async (source, target) => {
      await rename(source, target);
      const competing = `${store.databaseFile}.partial`;
      await fs.writeFile(competing, competingBody);
      await rename(competing, store.databaseFile);
    });
    expect(cityOf(await store.load())).toBe("Vienna");
    await expectPublished(store, competingBody);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the first download invisible while its staged file is being written", async () => {
    const firstBody = cityDatabase("Vienna");
    const firstStore = createStore(firstBody);
    const secondDownloaded = vi.fn();
    const secondStore = createStore(cityDatabase("Paris"), {
      downloaded: secondDownloaded,
    });
    const beforeWrite = createDeferred<void>();
    const finishWrite = createDeferred<void>();
    let writeStarted = false;
    const writeFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file, data, options) => {
      writeStarted = true;
      beforeWrite.resolve();
      await finishWrite.promise;
      return await writeFile(file, data, options);
    });

    const nativeMode = getFsSafeNativeConfig().mode;
    configureFsSafeNative({ mode: "off" });
    const firstLoading = firstStore.load();
    try {
      await Promise.race([beforeWrite.promise, firstLoading]);
      expect(writeStarted).toBe(true);
      await expect(fs.stat(firstStore.databaseFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(cityOf(await secondStore.load())).toBe("Paris");
      expect(secondDownloaded).toHaveBeenCalledOnce();
    } finally {
      finishWrite.resolve();
      try {
        await firstLoading;
      } finally {
        configureFsSafeNative({ mode: nativeMode });
      }
    }

    expect(cityOf(await firstLoading)).toBe("Vienna");
    await expectPublished(firstStore, firstBody);
  });

  it.each(["staging", "publication", "download", "parse"] as const)(
    "preserves the disk cache when %s fails",
    async (failure) => {
      const oldBody = cityDatabase("Vienna");
      const warn = vi.fn();
      const store = createStore(
        failure === "parse" ? Buffer.from("invalid MMDB") : cityDatabase("Paris"),
        {
          downloaded: async () => {
            if (failure === "download") {
              throw new Error("synthetic download failure");
            }
          },
          warn,
        },
      );
      await seedCache(store, oldBody);
      if (failure === "publication") {
        vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("synthetic publication failure"));
      } else if (failure === "staging") {
        const writeFile = fs.writeFile;
        vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file, _data, options) => {
          await writeFile(file, cityDatabase("Paris").subarray(0, 10), options);
          throw new Error("synthetic partial write failure");
        });
      }

      expect(cityOf(await store.load())).toBe(
        failure === "publication" || failure === "staging" ? "Paris" : "Vienna",
      );
      await expectPublished(store, oldBody);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it("publishes overlapping stores with their own readers through a symlinked cache", async () => {
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
    const firstStore = createStore(firstBody, { downloaded });
    const stores = [firstStore, createStore(secondBody, { downloaded })];

    const databases = await Promise.allSettled(stores.map((store) => store.load()));

    expect(
      databases.map((result) =>
        result.status === "fulfilled" ? cityOf(result.value) : result.reason,
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
    expect(cityOf(await firstStore.load())).toBe("Vienna");
    expect(downloads).toBe(2);
  });
});
