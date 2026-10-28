import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveGeolocationSettings } from "./config.js";
import { createGeolocationDatabaseStore } from "./database-store.js";

const now = new Date("2026-01-03T00:00:00Z");
let stateDir: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  // Realpath first: macOS tmp is a symlink and the store compares resolved paths.
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "geolocation-store-")));
});

function jsonResponse(body: Buffer, ok = true): Response {
  return new Response(Uint8Array.from(body), { status: ok ? 200 : 404 });
}

function oversizedResponse(cancel: () => Promise<void>): Response {
  let remaining = 3;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (remaining-- > 0) {
            controller.enqueue(new Uint8Array(128 * 1024 * 1024));
          } else {
            controller.close();
          }
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

it("tries the previous month when the current build is not published yet", async () => {
  const store = createStore(async () => jsonResponse(Buffer.from("nope"), false), {
    databaseUrl: "https://host.test/db-{yyyy}-{mm}.mmdb",
  });

  await expect(store.load()).rejects.toThrow(/db-2026-01.*db-2025-12/s);
});

it("shares an oversized download and rejects callers only after cancellation settles", async () => {
  // The third 128 MiB chunk exceeds the 256 MiB compressed ceiling.
  const cancellationStarted = createDeferred<void>();
  const finishCancellation = createDeferred<void>();
  let cancellationFinished = false;
  const store = createStore(async () =>
    oversizedResponse(async () => {
      cancellationStarted.resolve();
      await finishCancellation.promise;
      cancellationFinished = true;
      throw new Error("synthetic cancellation failure");
    }),
  );

  const loading = store.load();
  const concurrent = Promise.allSettled([loading, store.load(), store.load()]);
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
  expect((await concurrent).every((result) => result.status === "rejected")).toBe(true);
  expect(store.fetchImpl).toHaveBeenCalledOnce();
  expect(cancellationFinished).toBe(true);
  await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
});

it("refuses a gzip source that inflates past the on-disk ceiling", async () => {
  const store = createStore(gzipSync(Buffer.alloc(700 * 1024 * 1024, 0)), {
    databaseUrl: "https://host.test/db.mmdb.gz",
  });

  await expect(store.load()).rejects.toThrow(/db\.mmdb\.gz/);
  await expect(fs.readdir(path.join(stateDir, "geolocation"))).rejects.toThrow();
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
  body: Buffer | typeof fetch = vienna,
  options: { databaseUrl?: string; warn?: (message: string) => void } = {},
) {
  const databaseUrl = options.databaseUrl ?? "https://host.test/db.mmdb";
  const settings = resolveGeolocationSettings({ databaseUrl });
  const fetchImpl = vi.fn<typeof fetch>(
    typeof body === "function" ? body : async () => jsonResponse(body),
  );
  const store = createGeolocationDatabaseStore({
    stateDir,
    settings,
    logger: options.warn ? { info: () => {}, warn: options.warn } : undefined,
    fetchImpl,
  });
  const digest = createHash("sha256").update(databaseUrl).digest("hex").slice(0, 12);
  const databaseFile = path.join(stateDir, "geolocation", `ip-city-${digest}.mmdb`);
  return { ...store, fetchImpl, settings, databaseFile };
}

const vienna = cityDatabase("Vienna");
const paris = cityDatabase("Paris");
type Store = ReturnType<typeof createStore>;
const cityOf = (database: Awaited<ReturnType<Store["load"]>>) =>
  database.lookup("8.8.8.8")?.city?.names.en;
async function seedCache(store: Store, body: Buffer) {
  await fs.mkdir(path.dirname(store.databaseFile));
  await fs.writeFile(store.databaseFile, body);
  await fs.utimes(store.databaseFile, 0, 0);
}
async function expectPublished({ databaseFile }: Store, body: Buffer) {
  expect(await fs.readFile(databaseFile)).toEqual(body);
  expect(await fs.readdir(path.dirname(databaseFile))).toEqual([path.basename(databaseFile)]);
}

it.each([true, false])("evicts idle readers only when published: %s", async (published) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const store = createStore();
  if (!published) {
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    store.fetchImpl
      .mockResolvedValueOnce(jsonResponse(vienna))
      .mockRejectedValue(new Error("source unavailable"));
  }
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
  expect(readFile).toHaveBeenCalledTimes(published ? 1 : 0);
  expect(store.fetchImpl).toHaveBeenCalledOnce();
  // An in-progress request may still own the old reader after idle eviction.
  expect(cityOf(active)).toBe("Vienna");
});

it("preserves failed-refresh backoff across idle reopens without extending it", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const store = createStore();
  store.fetchImpl.mockRejectedValue(new Error("source unavailable"));
  await seedCache(store, vienna);

  expect(cityOf(await store.load())).toBe("Vienna");
  expect(store.fetchImpl).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  vi.setSystemTime(now.getTime() + 60_000);
  expect(cityOf(await store.load())).toBe("Vienna");
  expect(store.fetchImpl).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(store.settings.refreshMs);
  vi.setSystemTime(now.getTime() + store.settings.refreshMs + 1);
  expect(cityOf(await store.load())).toBe("Vienna");
  expect(store.fetchImpl).toHaveBeenCalledTimes(2);
});

it("publishes concurrent stores atomically through a symlink without replacing their readers", async () => {
  const storage = path.join(stateDir, "cache");
  await fs.mkdir(storage, { mode: 0o750 });
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(storage, path.join(stateDir, "geolocation"), linkType);
  const warn = vi.fn();
  const firstStore = createStore(vienna, { warn });
  const secondStore = createStore(paris);
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
    configureFsSafeNative({ mode: nativeMode });
    expect(cityOf(await secondStore.load())).toBe("Paris");
    configureFsSafeNative({ mode: "off" });
    // Replace the first publication before its load returns, as another process could.
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementationOnce(async (source, target) => {
      await rename(source, target);
      await expect(fs.readFile(firstStore.databaseFile)).resolves.toEqual(vienna);
      const competing = `${firstStore.databaseFile}.partial`;
      await writeFile(competing, paris);
      await rename(competing, firstStore.databaseFile);
    });
  } finally {
    finishWrite.resolve();
    await firstLoading.finally(() => configureFsSafeNative({ mode: nativeMode }));
  }

  expect(cityOf(await firstLoading)).toBe("Vienna");
  expect(cityOf(await secondStore.load())).toBe("Paris");
  expect(firstStore.fetchImpl).toHaveBeenCalledOnce();
  expect(warn).not.toHaveBeenCalled();
  await expectPublished(firstStore, paris);
  if (process.platform !== "win32") {
    expect((await fs.stat(firstStore.databaseFile)).mode & 0o777).toBe(0o666 & ~process.umask());
    expect((await fs.stat(storage)).mode & 0o777).toBe(0o750 & ~process.umask());
  }
});

const failures = ["staging", "publication", "download", "parse"] as const;
it.each(failures)("preserves the disk cache when %s fails", async (failure) => {
  const warn = vi.fn();
  const store = createStore(failure === "parse" ? Buffer.from("invalid MMDB") : paris, { warn });
  if (failure === "download") {
    store.fetchImpl.mockRejectedValue(new Error("synthetic download failure"));
  }
  await seedCache(store, vienna);
  if (failure === "publication") {
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("synthetic publication failure"));
  } else if (failure === "staging") {
    const writeFile = fs.writeFile;
    vi.spyOn(fs, "writeFile").mockImplementationOnce(async (file, _data, options) => {
      await writeFile(file, paris.subarray(0, 10), options);
      throw new Error("synthetic partial write failure");
    });
  }

  expect(cityOf(await store.load())).toBe(
    failure === "publication" || failure === "staging" ? "Paris" : "Vienna",
  );
  await expectPublished(store, vienna);
  expect(warn).toHaveBeenCalledOnce();
});
