import * as fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { dayKeyFor } from "./day.js";
import { logbookSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
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

const workerModuleUrl = resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint);
const stores: LogbookStore[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all(stores.splice(0).map((store) => store.close()));
    } finally {
      vi.restoreAllMocks();
      cleanup();
    }
  }),
);

async function open(dataDir: string) {
  const store = await LogbookStore.open(dataDir, workerModuleUrl);
  stores.push(store);
  return store;
}

function capture(store: LogbookStore, day: string, capturedAtMs: number, buffer: Buffer) {
  return store.captureFrame({ day, capturedAtMs, screenIndex: 0, buffer });
}

async function aliasedFrameRead() {
  const directory = tempDirs.make("logbook-frame-read-");
  const dataDir = path.join(directory, "data");
  const aliasDir = path.join(directory, "alias");
  const owner = await open(dataDir);
  await fs.symlink(dataDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
  const reader = await open(aliasDir);
  const day = dayKeyFor(1);
  const bytes = Buffer.from("synthetic frame");
  const frameId = await capture(owner, day, 1, bytes);
  const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  vi.mocked(fs.readFile).mockImplementationOnce(async (file) => {
    entered.resolve();
    await release.promise;
    return await actualFs.readFile(file);
  });
  return { owner, reader, day, bytes, frameId, entered, release };
}

it.each(["frame", "batch"] as const)(
  "drains an admitted %s read before pruning through a directory alias or closing its client",
  async (kind) => {
    const { owner, reader, day, bytes, frameId, entered, release } = await aliasedFrameRead();
    const batchId = await owner.createBatch({ day, startMs: 1, endMs: 2, frameIds: [frameId] });
    const reading = kind === "frame" ? reader.framePayload(frameId) : reader.batchImages(batchId);
    await entered.promise;
    const pruned = vi.fn((count: number) => count);
    const closed = vi.fn();
    const pruning = owner.pruneFrames(2).then(pruned);
    const closing = reader.close().then(closed);
    try {
      // Two real worker replies put any incorrectly dispatched prune ahead of the metadata read.
      await owner.countCardsForDay(day);
      expect(await owner.frameById(frameId)).not.toBeNull();
      expect([pruned.mock.calls, closed.mock.calls]).toEqual([[], []]);
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
  const { owner, reader, day, bytes, frameId, entered, release } = await aliasedFrameRead();
  const reads = Array.from({ length: 128 }, () => reader.framePayload(frameId));
  const accepted = Promise.allSettled(reads);
  await entered.promise;
  const overflowResult = vi.fn();
  const overflow = reader.framePayload(frameId).catch(overflowResult);
  const closed = vi.fn();
  const closing = reader.close().then(closed);
  try {
    await owner.countCardsForDay(day);
    expect(overflowResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "overloaded" }),
    );
    expect(closed).not.toHaveBeenCalled();
    release.resolve();
    const outcomes = await accepted;
    expect(outcomes).toEqual(
      Array.from({ length: 128 }, () => ({
        status: "fulfilled",
        value: expect.objectContaining({ base64: bytes.toString("base64") }),
      })),
    );
    await closing;
    expect(await owner.framePayload(frameId)).toMatchObject({ base64: bytes.toString("base64") });
  } finally {
    release.resolve();
    await Promise.allSettled([accepted, overflow, closing]);
  }
});

it("loads a sampled batch larger than the worker result limit without transporting image buffers", async () => {
  const store = await open(tempDirs.make("logbook-large-images-"));
  const day = "2026-07-03";
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const frameIds: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    frameIds.push(await capture(store, day, index + 1, bytes));
  }
  const batchId = await store.createBatch({ day, startMs: 1, endMs: 10, frameIds });
  const images = await store.batchImages(batchId);
  expect(openNodeSqliteDatabase).not.toHaveBeenCalled();
  expect(images.map((image) => image.frame.id)).toEqual(frameIds);
  for (const image of images) {
    expect(Buffer.isBuffer(image.buffer)).toBe(true);
    expect(image.buffer).toMatchObject({ length: bytes.length, 0: 0x61, [bytes.length - 1]: 0x61 });
  }
});
