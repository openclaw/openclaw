import * as fs from "node:fs/promises";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openNodeSqliteDatabase, openSqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logbookSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { LogbookStore } from "./store.js";

vi.mock("openclaw/plugin-sdk/sqlite-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-runtime")>();
  return { ...actual, openSqliteWorkerStore: vi.fn(actual.openSqliteWorkerStore) };
});

const workerModuleUrl = resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint);
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

function persistedState(dataDir: string) {
  const db = openNodeSqliteDatabase(path.join(dataDir, "logbook.sqlite"), { readOnly: true });
  try {
    return ["sqlite_schema", "batches", "frames", "observations", "cards", "standups"].map(
      (table) => ({ table, rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() }),
    );
  } finally {
    db.close();
  }
}

async function fixture(count: number) {
  const dataDir = tempDirs.make("logbook-batch-sample-");
  const initial = await open(dataDir);
  await initial.close();
  for (let id = 1; id <= count; id++) {
    await fs.writeFile(path.join(dataDir, "frames", `${id}.jpg`), Buffer.from(`frame ${id}`));
  }
  const db = openNodeSqliteDatabase(path.join(dataDir, "logbook.sqlite"));
  try {
    // A pruned batch can retain a larger original frame_count than its live rows.
    db.prepare(
      "INSERT INTO batches (id, day, start_ms, end_ms, status, frame_count, created_ms, updated_ms) VALUES (1, '2026-07-03', 0, 10000, 'pending', ?, 0, 0)",
    ).run(count + 7);
    const insert = db.prepare(
      "INSERT INTO frames (id, captured_at_ms, day, path, screen_index, width, height, byte_size, content_hash, idle, batch_id) VALUES (?, ?, '2026-07-03', ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    db.exec("BEGIN");
    for (let id = 1; id <= count; id++) {
      const file = path.join(dataDir, "frames", `${id}.jpg`);
      const bytes = Buffer.from(`frame ${id}`);
      insert.run(
        id,
        Math.floor((count - id) / 2),
        file,
        id % 2,
        id % 2 === 0 ? 640 : null,
        id % 2 === 0 ? 480 : null,
        bytes.byteLength,
        `hash-${id}`,
        id % 3 === 0 ? 1 : 0,
        1,
      );
    }
    // An unrelated unbatched frame has no file and must never enter this sample.
    insert.run(count + 1, 0, path.join(dataDir, "missing.jpg"), 0, null, null, 0, "other", 0, null);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return { dataDir, store: await open(dataDir) };
}

describe("Logbook sampled batch images", () => {
  it.each([0, 1, 16, 17, 30, 31, 1440, 2000])(
    "keeps the chronological sample and bounds transported metadata for %i frames",
    async (count) => {
      const { dataDir, store } = await fixture(count);
      const frames = await store.batchFrames(1);
      expect(frames).toHaveLength(count);
      const expected =
        count <= 16
          ? frames
          : Array.from(
              { length: 16 },
              (_, index) => frames[Math.round(index * ((count - 1) / 15))],
            );
      const before = persistedState(dataDir);
      const worker = await vi.mocked(openSqliteWorkerStore).mock.results.at(-1)?.value;
      if (!worker) {
        throw new Error("Expected the actual Logbook worker");
      }
      const transport = vi.spyOn(worker, "execute");
      const images = await store.batchImages(1);
      expect(images.map(({ frame }) => frame)).toEqual(expected);
      for (const image of images) {
        expect(image.buffer).toEqual(Buffer.from(`frame ${image.frame.id}`));
      }
      const replies = await Promise.all(transport.mock.results.map((result) => result.value));
      const transportedRows = replies.reduce<number>(
        (total, value) => total + (Array.isArray(value) ? value.length : 0),
        0,
      );
      expect(transportedRows).toBeLessThanOrEqual(16);
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
    const { dataDir, store } = await fixture(17);
    const frames = await store.batchFrames(1);
    const unsampled = frames[8];
    const selected = frames[0];
    if (!unsampled || !selected) {
      throw new Error("Expected sampled and unsampled frame fixtures");
    }
    const before = persistedState(dataDir);
    await fs.unlink(unsampled.path);
    expect(await store.batchImages(1)).toHaveLength(16);
    await fs.unlink(selected.path);
    await expect(store.batchImages(1)).rejects.toMatchObject({
      code: "ENOENT",
      path: selected.path,
    });
    expect(persistedState(dataDir)).toEqual(before);
    await store.close();
    const reopened = await open(dataDir);
    await expect(reopened.batchImages(1)).rejects.toMatchObject({
      code: "ENOENT",
      path: selected.path,
    });
  });
});
