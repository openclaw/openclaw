import * as fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dayKeyFor } from "./day.js";
import { LogbookStore } from "./store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: vi.fn(() => {
      throw new Error("Logbook must not open SQLite in the application thread");
    }),
  };
});

const workerModuleUrl = new URL("./store.worker.ts", import.meta.url);
const stores = new Set<LogbookStore>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      vi.restoreAllMocks();
      cleanup();
    }
  }),
);

async function open(dataDir: string) {
  const store = await LogbookStore.open(dataDir, workerModuleUrl);
  stores.add(store);
  return store;
}

describe("Logbook worker and frame I/O ownership", () => {
  it("bootstraps and reopens durable state without opening SQLite in the application thread", async () => {
    const directory = tempDirs.make("logbook-worker-bootstrap-");
    const store = await open(directory);
    await store.saveStandup("2026-07-03", "Persisted through the worker");
    await store.close();
    const reopened = await open(directory);
    expect(await reopened.getStandup("2026-07-03")).toMatchObject({
      text: "Persisted through the worker",
    });
    expect(openNodeSqliteDatabase).not.toHaveBeenCalled();
  });

  it.each(["frame", "batch"] as const)(
    "drains an admitted %s read before pruning through a directory alias or closing its client",
    async (kind) => {
      const directory = tempDirs.make("logbook-frame-drain-");
      const dataDir = path.join(directory, "data");
      const aliasDir = path.join(directory, "alias");
      const owner = await open(dataDir);
      await fs.symlink(dataDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
      const reader = await open(aliasDir);
      const day = dayKeyFor(1);
      const bytes = Buffer.from("synthetic frame before pruning");
      const frameId = await owner.captureFrame({
        capturedAtMs: 1,
        day,
        screenIndex: 0,
        buffer: bytes,
      });
      const batchId = await owner.createBatch({ day, startMs: 1, endMs: 2, frameIds: [frameId] });
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      vi.mocked(fs.readFile).mockImplementationOnce(async (file) => {
        entered.resolve();
        await release.promise;
        return await actualFs.readFile(file);
      });
      const reading = kind === "frame" ? reader.framePayload(frameId) : reader.batchImages(batchId);
      await entered.promise;
      let pruned = false;
      let closed = false;
      const pruning = owner.pruneFrames(2).then((count) => {
        pruned = true;
        return count;
      });
      const closing = reader.close().then(() => {
        closed = true;
      });
      try {
        // Two real worker replies put any incorrectly dispatched prune ahead of the metadata read.
        await owner.countCardsForDay(day);
        expect(await owner.frameById(frameId)).not.toBeNull();
        expect(pruned).toBe(false);
        expect(closed).toBe(false);
        release.resolve();
        if (kind === "frame") {
          expect(await reading).toMatchObject({ frameId, base64: bytes.toString("base64") });
        } else {
          expect(await reading).toEqual([
            { frame: expect.objectContaining({ id: frameId }), buffer: bytes },
          ]);
        }
        expect(await pruning).toBe(1);
        await closing;
        expect(await owner.frameById(frameId)).toBeNull();
        await expect(fs.stat(owner.frameFilePath(day, 1))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        release.resolve();
        await Promise.allSettled([reading, pruning, closing]);
      }
    },
  );

  it("bounds pending frame reads and keeps admitted reads alive through close", async () => {
    const directory = tempDirs.make("logbook-frame-capacity-");
    const dataDir = path.join(directory, "data");
    const aliasDir = path.join(directory, "alias");
    const owner = await open(dataDir);
    await fs.symlink(dataDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const reader = await open(aliasDir);
    const bytes = Buffer.from("bounded frame queue");
    const day = "2026-07-03";
    const frameId = await owner.captureFrame({
      capturedAtMs: 1,
      day,
      screenIndex: 0,
      buffer: bytes,
    });
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    vi.mocked(fs.readFile).mockImplementationOnce(async (file) => {
      entered.resolve();
      await release.promise;
      return await actualFs.readFile(file);
    });
    const reads = Array.from({ length: 128 }, () => reader.framePayload(frameId));
    const accepted = Promise.allSettled(reads);
    await entered.promise;
    let overflowResult:
      | { status: "fulfilled" }
      | { status: "rejected"; reason: unknown }
      | undefined;
    const overflow = reader.framePayload(frameId).then(
      () => {
        overflowResult = { status: "fulfilled" };
      },
      (reason: unknown) => {
        overflowResult = { status: "rejected", reason };
      },
    );
    let closed = false;
    const closing = reader.close().then(() => {
      closed = true;
    });
    try {
      await owner.countCardsForDay(day);
      expect(overflowResult).toMatchObject({ status: "rejected", reason: { code: "overloaded" } });
      expect(closed).toBe(false);
      release.resolve();
      const outcomes = await accepted;
      expect(outcomes.find((result) => result.status === "rejected")).toBeUndefined();
      expect(
        outcomes.every(
          (result) =>
            result.status === "fulfilled" && result.value?.base64 === bytes.toString("base64"),
        ),
      ).toBe(true);
      await closing;
      expect(await owner.framePayload(frameId)).toMatchObject({ base64: bytes.toString("base64") });
    } finally {
      release.resolve();
      await Promise.allSettled([accepted, overflow, closing]);
    }
  });

  it("loads a sampled batch larger than the worker result limit without transporting image buffers", async () => {
    const dataDir = tempDirs.make("logbook-large-images-");
    const store = await open(dataDir);
    const day = "2026-07-03";
    const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const frameIds: number[] = [];
    for (let index = 0; index < 9; index += 1) {
      const file = store.frameFilePath(day, index + 1);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
      frameIds.push(
        await store.insertFrame({
          capturedAtMs: index + 1,
          day,
          path: file,
          screenIndex: 0,
          byteSize: bytes.byteLength,
          contentHash: `synthetic-${index}`,
          idle: false,
        }),
      );
    }
    const batchId = await store.createBatch({ day, startMs: 1, endMs: 10, frameIds });
    const images = await store.batchImages(batchId);
    expect(images).toHaveLength(9);
    expect(images.reduce((total, image) => total + image.buffer.byteLength, 0)).toBe(
      72 * 1024 * 1024,
    );
    expect(images.map((image) => image.frame.id)).toEqual(frameIds);
    for (const image of images) {
      expect(Buffer.isBuffer(image.buffer)).toBe(true);
      expect(image.buffer.byteLength).toBe(bytes.byteLength);
      expect(image.buffer[0]).toBe(0x61);
      expect(image.buffer.at(-1)).toBe(0x61);
    }
  });
});
