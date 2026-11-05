import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { expect, it, vi } from "vitest";
import { dayKeyFor } from "./day.js";
import { LogbookStore } from "./store.js";
import { useLogbookFixture, withDatabase } from "./test-fixtures.test-support.js";

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

const { makeDir, open } = useLogbookFixture("logbook-frame-io-");

function capture(store: LogbookStore, day: string, capturedAtMs: number, buffer: Buffer) {
  return store.captureFrame({ day, capturedAtMs, screenIndex: 0, buffer });
}

async function aliasedFrameRead() {
  const directory = makeDir();
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

it.each([
  ["frame", 1],
  ["batch", 1],
  ["frame", 128],
] as const)(
  "drains %s reads (queue size %i) through alias pruning and client close",
  async (kind, count) => {
    const { owner, reader, day, bytes, frameId, entered, release } = await aliasedFrameRead();
    const batchId = await owner.createBatch({ day, startMs: 1, endMs: 2, frameIds: [frameId] });
    const read = () =>
      kind === "frame" ? reader.framePayload(frameId) : reader.batchImages(batchId);
    const accepted = Promise.allSettled(Array.from({ length: count }, read));
    await entered.promise;
    const overflowResult = vi.fn();
    const overflow = count === 128 ? read().catch(overflowResult) : Promise.resolve();
    const pruned = vi.fn((result: number) => result);
    const pruning = count === 1 ? owner.pruneFrames(2).then(pruned) : Promise.resolve(0);
    const closed = vi.fn();
    const closing = reader.close().then(closed);
    try {
      // Two real worker replies expose a prune incorrectly dispatched ahead of the blocked read.
      await owner.countCardsForDay(day);
      expect(await owner.framesInRange(1, 2)).toEqual([expect.objectContaining({ id: frameId })]);
      expect([pruned.mock.calls, closed.mock.calls]).toEqual([[], []]);
      if (count === 128) {
        expect(overflowResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ code: "overloaded" }),
        );
      }
      release.resolve();
      const value =
        kind === "frame"
          ? expect.objectContaining({ frameId, base64: bytes.toString("base64") })
          : [{ frame: expect.objectContaining({ id: frameId }), buffer: bytes }];
      expect(await accepted).toEqual(
        Array.from({ length: count }, () => ({ status: "fulfilled", value })),
      );
      expect(await pruning).toBe(count === 1 ? 1 : 0);
      await closing;
      if (count === 1) {
        expect(await owner.framesInRange(1, 2)).toEqual([]);
        await expect(fs.stat(owner.frameFilePath(day, 1))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(await owner.framePayload(frameId)).toMatchObject({
          base64: bytes.toString("base64"),
        });
      }
    } finally {
      release.resolve();
      await Promise.allSettled([accepted, overflow, pruning, closing]);
    }
  },
);

it("loads a sampled batch larger than the worker result limit without transporting image buffers", async () => {
  const store = await open(makeDir());
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

function persistedState(dataDir: string) {
  return withDatabase(
    path.join(dataDir, "logbook.sqlite"),
    (db) =>
      ["sqlite_schema", "batches", "frames", "observations", "cards", "standups"].map((table) => ({
        table,
        rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      })),
    true,
  );
}

async function fixture(count: number) {
  const dataDir = makeDir();
  await (await open(dataDir)).close();
  const frames: Array<{ id: number; capturedAtMs: number; path: string }> = [];
  withDatabase(path.join(dataDir, "logbook.sqlite"), (db) => {
    // A pruned batch can retain a larger original frame_count than its live rows.
    db.prepare(
      "INSERT INTO batches (id, day, start_ms, end_ms, status, frame_count, created_ms, updated_ms) VALUES (1, '2026-07-03', 0, 10000, 'pending', ?, 0, 0)",
    ).run(count + 7);
    const insert = db.prepare(
      "INSERT INTO frames (id, captured_at_ms, day, path, content_hash, idle, batch_id) VALUES (?, ?, '2026-07-03', ?, 'hash', ?, 1)",
    );
    db.exec("BEGIN");
    for (let id = 1; id <= count; id++) {
      const file = path.join(dataDir, "frames", `${id}.jpg`);
      fsSync.writeFileSync(file, `frame ${id}`);
      const frame = { id, capturedAtMs: Math.floor((count - id) / 2), path: file };
      frames.push(frame);
      insert.run(id, frame.capturedAtMs, file, Number(id % 3 === 0));
    }
    // An unrelated unbatched frame has no file and must never enter this sample.
    db.prepare(
      "INSERT INTO frames (id, captured_at_ms, day, path, content_hash) VALUES (?, 0, '2026-07-03', ?, 'other')",
    ).run(count + 1, path.join(dataDir, "missing.jpg"));
    db.exec("COMMIT");
  });
  frames.sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.id - b.id);
  return { dataDir, store: await open(dataDir), frames };
}

it.each([0, 16, 17, 2000])(
  "keeps the chronological sample bounded for %i frames without changing stored data",
  async (count) => {
    const { dataDir, store, frames } = await fixture(count);
    const expected =
      count <= 16
        ? frames
        : Array.from({ length: 16 }, (_, index) => frames[Math.round(index * ((count - 1) / 15))]);
    const before = persistedState(dataDir);
    const images = await store.batchImages(1);
    expect(images).toMatchObject(
      expected.map((frame) => ({ frame, buffer: Buffer.from(`frame ${frame?.id}`) })),
    );
    expect(persistedState(dataDir)).toEqual(before);
    await store.saveStandup("2026-07-03", "Writable after sampling");
    expect(await store.getStandup("2026-07-03")).toMatchObject({
      text: "Writable after sampling",
    });
  },
);

it("ignores an unsampled missing file and propagates the first selected file error", async () => {
  const { dataDir, store, frames } = await fixture(17);
  const unsampled = expectDefined(frames[8], "unsampled frame");
  const selected = expectDefined(frames[0], "selected frame");
  const missingFile = { code: "ENOENT", path: selected.path };
  const before = persistedState(dataDir);
  fsSync.unlinkSync(unsampled.path);
  expect(await store.batchImages(1)).toHaveLength(16);
  fsSync.unlinkSync(selected.path);
  await expect(store.batchImages(1)).rejects.toMatchObject(missingFile);
  expect(persistedState(dataDir)).toEqual(before);
  await store.close();
  const reopened = await open(dataDir);
  await expect(reopened.batchImages(1)).rejects.toMatchObject(missingFile);
});
