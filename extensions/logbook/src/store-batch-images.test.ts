import * as fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { openEngineWorkerStore } from "openclaw/plugin-sdk/database-engine-runtime";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { expect, it, vi } from "vitest";
import { useLogbookFixture, withDatabase } from "./test-fixtures.test-support.js";
import type { LogbookFrame } from "./types.js";

vi.mock("openclaw/plugin-sdk/database-engine-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/database-engine-runtime")>();
  return { ...actual, openEngineWorkerStore: vi.fn(actual.openEngineWorkerStore) };
});

const { makeDir, open } = useLogbookFixture("logbook-batch-sample-");

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
  const db = openNodeSqliteDatabase(path.join(dataDir, "logbook.sqlite"));
  const frames: LogbookFrame[] = [];
  try {
    // A pruned batch can retain a larger original frame_count than its live rows.
    db.prepare(
      "INSERT INTO batches (id, day, start_ms, end_ms, status, frame_count, created_ms, updated_ms) VALUES (1, '2026-07-03', 0, 10000, 'pending', ?, 0, 0)",
    ).run(count + 7);
    const insert = db.prepare(
      "INSERT INTO frames (id, captured_at_ms, day, path, screen_index, width, height, byte_size, content_hash, idle, batch_id) VALUES (@id, @capturedAtMs, @day, @path, @screenIndex, @width, @height, @byteSize, @contentHash, @idle, @batchId)",
    );
    db.exec("BEGIN");
    for (let id = 1; id <= count; id++) {
      const file = path.join(dataDir, "frames", `${id}.jpg`);
      fs.writeFileSync(file, `frame ${id}`);
      const frame: LogbookFrame = {
        id,
        capturedAtMs: Math.floor((count - id) / 2),
        day: "2026-07-03",
        path: file,
        screenIndex: id % 2,
        width: id % 2 === 0 ? 640 : undefined,
        height: id % 2 === 0 ? 480 : undefined,
        byteSize: Buffer.byteLength(`frame ${id}`),
        idle: id % 3 === 0,
      };
      frames.push(frame);
      insert.run({
        ...frame,
        width: frame.width ?? null,
        height: frame.height ?? null,
        contentHash: `hash-${id}`,
        idle: Number(frame.idle),
        batchId: 1,
      });
    }
    // An unrelated unbatched frame has no file and must never enter this sample.
    db.prepare(
      "INSERT INTO frames (id, captured_at_ms, day, path, content_hash) VALUES (?, 0, '2026-07-03', ?, 'other')",
    ).run(count + 1, path.join(dataDir, "missing.jpg"));
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  frames.sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.id - b.id);
  return { dataDir, store: await open(dataDir), frames };
}

it.each([0, 16, 17, 2000])(
  "keeps the chronological sample and bounds transported metadata for %i frames",
  async (count) => {
    const { dataDir, store, frames } = await fixture(count);
    const expected =
      count <= 16
        ? frames
        : Array.from({ length: 16 }, (_, index) => frames[Math.round(index * ((count - 1) / 15))]);
    const before = persistedState(dataDir);
    const worker = expectDefined(
      await vi.mocked(openEngineWorkerStore).mock.results.at(-1)?.value,
      "Logbook worker",
    );
    const transport = vi.spyOn(worker, "execute");
    const images = await store.batchImages(1);
    expect(images).toEqual(
      expected.map((frame) => ({ frame, buffer: Buffer.from(`frame ${frame?.id}`) })),
    );
    const replies = await Promise.all(transport.mock.results.map((result) => result.value));
    expect(replies.filter(Array.isArray).flat().length).toBeLessThanOrEqual(16);
    expect(persistedState(dataDir)).toEqual(before);
    await store.close();
    const reopened = await open(dataDir);
    expect(await reopened.batchImages(1)).toEqual(images);
    expect(persistedState(dataDir)).toEqual(before);
    await reopened.saveStandup("2026-07-03", "Writable after sampling");
    expect(await reopened.getStandup("2026-07-03")).toMatchObject({
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
  fs.unlinkSync(unsampled.path);
  expect(await store.batchImages(1)).toHaveLength(16);
  fs.unlinkSync(selected.path);
  await expect(store.batchImages(1)).rejects.toMatchObject(missingFile);
  expect(persistedState(dataDir)).toEqual(before);
  await store.close();
  const reopened = await open(dataDir);
  await expect(reopened.batchImages(1)).rejects.toMatchObject(missingFile);
});
