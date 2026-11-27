import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openNodeSqliteDatabase,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import type { LogbookOperations } from "./store-contract.js";
import { createSqliteWorkerBackend } from "./store.worker.js";
import { cardDraft, frameInput } from "./test-fixtures.test-support.js";

const backends: SqliteWorkerBackend<LogbookOperations>[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all(backends.splice(0).map((backend) => Promise.resolve(backend.close())));
    } finally {
      cleanup();
    }
  }),
);
const day = "2026-07-03";

it("retains persisted standups across reopen and physical database replacement", async () => {
  const dataDir = tempDirs.make("logbook-schema-admission-");
  const databasePath = path.join(dataDir, "logbook.sqlite");
  // Keep the original physical store admitted through reopen and pathname replacement.
  using owner = openNodeSqliteDatabase(databasePath);
  expect(owner.isOpen).toBe(true);
  for (let opened = 0; opened < 3; opened += 1) {
    const backend = createSqliteWorkerBackend({ dataDir }, { databasePath });
    try {
      if (opened === 0) {
        backend.execute({ type: "saveStandup", input: { day, text: "Persisted standup" } });
      }
      expect(backend.execute({ type: "getStandup", input: { day } })).toMatchObject({
        text: "Persisted standup",
      });
    } finally {
      await backend.close();
    }
    if (opened === 1) {
      renameSync(databasePath, `${databasePath}.original`);
      copyFileSync(`${databasePath}.original`, databasePath);
    }
  }
});

function openBackend() {
  const dataDir = tempDirs.make("logbook-read-budget-");
  const databasePath = path.join(dataDir, "logbook.sqlite");
  const backend = createSqliteWorkerBackend({ dataDir }, { databasePath });
  backends.push(backend);
  return { backend, databasePath };
}

describe("Logbook native statement and read budgets", () => {
  it("polls only pending batches in timestamp/id order", () => {
    const { backend, databasePath } = openBackend();
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec(`
        WITH RECURSIVE history(id) AS (
          VALUES (1) UNION ALL SELECT id + 1 FROM history WHERE id < 1000
        )
        INSERT INTO batches (id, day, start_ms, end_ms, status, created_ms, updated_ms)
        SELECT id, '${day}', id, id + 1, 'done', 0, 0 FROM history;
        INSERT INTO batches (id, day, start_ms, end_ms, status, created_ms, updated_ms)
        VALUES (1001, '${day}', 3000, 4000, 'pending', 0, 0),
               (1002, '${day}', 2000, 3000, 'pending', 0, 0),
               (1003, '${day}', 2000, 3000, 'pending', 0, 0);
      `);
    } finally {
      writer.close();
    }
    for (const id of [1002, 1003, 1001]) {
      expect(backend.execute({ type: "nextPendingBatch", input: undefined })).toMatchObject({
        id,
        status: "pending",
      });
      backend.execute({ type: "setBatchStatus", input: { batchId: id, status: "done" } });
    }
    expect(backend.execute({ type: "nextPendingBatch", input: undefined })).toBeNull();
  });

  it("stores fresh optional values and coalesces batch models", () => {
    const { backend } = openBackend();
    const firstFrame = frameInput({
      capturedAtMs: 1,
      path: "first.jpg",
      width: 640,
      height: 480,
      byteSize: 10,
      contentHash: "first",
    });
    expect(backend.execute({ type: "insertFrame", input: firstFrame })).toBe(1);
    expect(
      backend.execute({
        type: "createBatch",
        input: { day, startMs: 1, endMs: 2, frameIds: [1] },
      }),
    ).toBe(1);
    backend.execute({ type: "saveStandup", input: { day, text: "Initial standup" } });
    backend.execute({
      type: "setBatchStatus",
      input: { batchId: 1, status: "error", error: "First failure", model: "synthetic/first" },
    });
    // The native cache retains a query on its second execution.
    expect(
      backend.execute({
        type: "insertFrame",
        input: { ...firstFrame, path: "warmup.jpg", contentHash: "warmup" },
      }),
    ).toBe(2);
    backend.execute({ type: "saveStandup", input: { day, text: "Warmup standup" } });
    backend.execute({
      type: "setBatchStatus",
      input: { batchId: 1, status: "running", error: "Warmup status" },
    });

    expect(
      backend.execute({
        type: "insertFrame",
        input: frameInput({
          capturedAtMs: 2,
          path: "second.jpg",
          screenIndex: 1,
          byteSize: 20,
          contentHash: "second",
          idle: true,
        }),
      }),
    ).toBe(3);
    backend.execute({ type: "saveStandup", input: { day, text: "Revised standup 🦞" } });
    backend.execute({ type: "saveStandup", input: { day: "2026-07-04", text: "Another day" } });
    backend.execute({ type: "setBatchStatus", input: { batchId: 1, status: "pending" } });
    expect(backend.execute({ type: "latestBatch", input: undefined })).toMatchObject({
      status: "pending",
      error: undefined,
      model: "synthetic/first",
    });
    backend.execute({
      type: "setBatchStatus",
      input: { batchId: 1, status: "done", model: "synthetic/second" },
    });

    expect(backend.execute({ type: "frameById", input: { id: 1 } })).toMatchObject({
      path: "first.jpg",
      width: 640,
      height: 480,
      screenIndex: 0,
      byteSize: 10,
      idle: false,
    });
    expect(backend.execute({ type: "frameById", input: { id: 2 } })).toMatchObject({
      path: "warmup.jpg",
      width: 640,
      height: 480,
    });
    expect(backend.execute({ type: "frameById", input: { id: 3 } })).toMatchObject({
      path: "second.jpg",
      width: undefined,
      height: undefined,
      screenIndex: 1,
      byteSize: 20,
      idle: true,
    });
    expect(backend.execute({ type: "lastFrame", input: undefined })).toEqual({
      capturedAtMs: 2,
      contentHash: "second",
    });
    expect(backend.execute({ type: "getStandup", input: { day } })).toMatchObject({
      text: "Revised standup 🦞",
    });
    expect(backend.execute({ type: "getStandup", input: { day: "2026-07-04" } })).toMatchObject({
      text: "Another day",
    });
    expect(backend.execute({ type: "latestBatch", input: undefined })).toMatchObject({
      status: "done",
      error: undefined,
      model: "synthetic/second",
    });
  });

  it("returns timeline cards, tracked time and independent counts", () => {
    const { backend } = openBackend();
    const drafts = Array.from({ length: 8 }, (_, index) =>
      cardDraft({
        startMs: index * 60_000,
        endMs: (index + 1) * 60_000,
        title: `Card ${index} 🦞`,
        detail: "Detailed activity",
      }),
    );
    backend.execute({
      type: "replaceCardsInWindow",
      input: { day, startMs: 0, endMs: Number.MAX_SAFE_INTEGER, drafts },
    });
    expect(backend.execute({ type: "timelineForDay", input: { day } })).toMatchObject({
      cards: drafts.map((draft) => expect.objectContaining(draft)),
      stats: { trackedMs: 8 * 60_000 },
    });
    expect(backend.execute({ type: "countCardsForDay", input: { day } })).toBe(8);
  });

  it("reads at most 200 observations with stable timestamp ties", () => {
    const { backend } = openBackend();
    const frameId = insertCandidate(backend, 1);
    if (typeof frameId !== "number") {
      throw new Error("Expected a frame id from the native backend");
    }
    const batchId = backend.execute({
      type: "createBatch",
      input: { day, startMs: 0, endMs: Number.MAX_SAFE_INTEGER, frameIds: [frameId] },
    });
    if (typeof batchId !== "number") {
      throw new Error("Expected a batch id from the native backend");
    }
    const segments = Array.from({ length: 201 }, (_, index) => ({
      startMs: 1 + Math.floor(index / 3) * 1000,
      endMs: 1001 + Math.floor(index / 3) * 1000,
      text: `Observation ${index} 🦞`,
    }));
    backend.execute({ type: "replaceObservations", input: { batchId, day, segments } });
    expect(
      backend.execute({
        type: "observationsInRange",
        input: { day, startMs: 0, endMs: Number.MAX_SAFE_INTEGER, tailLimit: 200 },
      }),
    ).toEqual(
      segments
        .map((segment, index) => Object.assign({ id: index + 1, batchId, day }, segment))
        .slice(-200),
    );
  });
  const keyframeDrafts = [0, 40_000].map((startMs) =>
    cardDraft({ startMs, endMs: startMs + 40_000, title: `Card ${startMs}` }),
  );
  function insertCandidate(
    backend: SqliteWorkerBackend<LogbookOperations>,
    capturedAtMs: number,
    idle = false,
  ) {
    return backend.execute({
      type: "insertFrame",
      input: frameInput({
        capturedAtMs,
        path: `captures/${"nested/".repeat(12)}${capturedAtMs}.jpg`,
        width: 640,
        height: 480,
        byteSize: 10,
        idle,
      }),
    });
  }

  it("returns ordered frame metadata while preserving full frame readers", () => {
    const { backend } = openBackend();
    insertCandidate(backend, 3000);
    insertCandidate(backend, 1000);
    insertCandidate(backend, 1000);
    insertCandidate(backend, 2000);
    insertCandidate(backend, 500, true);
    insertCandidate(backend, 750);
    backend.execute({
      type: "createBatch",
      input: { day, startMs: 750, endMs: 751, frameIds: [6] },
    });
    const expected = [
      { id: 2, capturedAtMs: 1000 },
      { id: 3, capturedAtMs: 1000 },
      { id: 4, capturedAtMs: 2000 },
      { id: 1, capturedAtMs: 3000 },
    ];
    for (const limit of [0, 2, 10]) {
      const pending = backend.execute({ type: "unbatchedActiveFrames", input: { limit } });
      expect(pending).toEqual(expected.slice(0, limit));
    }

    const range = backend.execute({ type: "framesInRange", input: { startMs: 500, endMs: 3000 } });
    expect(range).toEqual([
      { id: 5, capturedAtMs: 500, idle: true },
      { id: 6, capturedAtMs: 750, idle: false },
      { id: 2, capturedAtMs: 1000, idle: false },
      { id: 3, capturedAtMs: 1000, idle: false },
      { id: 4, capturedAtMs: 2000, idle: false },
    ]);

    const fullFrame = {
      id: 6,
      capturedAtMs: 750,
      day,
      path: `captures/${"nested/".repeat(12)}750.jpg`,
      screenIndex: 0,
      width: 640,
      height: 480,
      byteSize: 10,
      idle: false,
    };
    expect(backend.execute({ type: "frameById", input: { id: 6 } })).toEqual(fullFrame);
    expect(backend.execute({ type: "sampledBatchFrames", input: { batchId: 1 } })).toEqual([
      fullFrame,
    ]);
  });

  it.each([0, 120])("selects keyframe ids for %i candidates", (count) => {
    const { backend } = openBackend();
    for (let index = 0; index < count; index += 1) {
      insertCandidate(backend, Math.floor(index / 2) * 1000);
    }
    insertCandidate(backend, -1);
    insertCandidate(backend, 120_000);
    backend.execute({
      type: "replaceCardsInWindow",
      input: { day, startMs: 0, endMs: 120_000, drafts: keyframeDrafts },
    });
    const expectedIds = count === 0 ? [undefined, undefined] : [41, 119];
    expect(backend.execute({ type: "cardsForDay", input: { day } })).toEqual(
      keyframeDrafts.map((draft, index) =>
        expect.objectContaining(Object.assign({}, draft, { keyframeId: expectedIds[index] })),
      ),
    );
  });
});
