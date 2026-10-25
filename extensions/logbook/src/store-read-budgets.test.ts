import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteWorkerBackend } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogbookOperations } from "./store-contract.js";
import { createSqliteWorkerBackend } from "./store.worker.js";
import { batchInput, cardDraft, frameInput } from "./test-fixtures.test-support.js";

const reads = vi.hoisted(() => ({
  cardQueries: 0,
  cardRows: 0,
  observationRows: 0,
  frameRows: 0,
  frameTextBytes: 0,
}));
const batchReads = vi.hoisted(() => [] as string[][]);
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-worker-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const db = actual.openNodeSqliteDatabase(...args);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (/\bfrom "batches"(?:\s|$)/i.test(sql)) {
          const get = statement.get.bind(statement);
          vi.spyOn(statement, "get").mockImplementation((...bindings) => {
            batchReads.push(
              prepare(`EXPLAIN QUERY PLAN ${sql}`)
                .all(...bindings)
                .map((row) => String(row.detail)),
            );
            return get(...bindings);
          });
        }
        const table = /\bfrom\s+"?(cards|observations|frames)\b/i.exec(sql)?.[1];
        if (!table) {
          return statement;
        }
        const record = (row: Record<string, unknown>) => {
          if (table === "cards") {
            reads.cardRows += Number("distractions" in row);
          } else if (table === "observations") {
            reads.observationRows += 1;
          } else {
            reads.frameRows += 1;
            reads.frameTextBytes += Object.values(row).reduce<number>(
              (bytes, value) => bytes + (typeof value === "string" ? Buffer.byteLength(value) : 0),
              0,
            );
          }
        };
        for (const method of ["get", "all"] as const) {
          const run = statement[method].bind(statement);
          vi.spyOn(statement, method).mockImplementation((...bindings) => {
            reads.cardQueries += Number(table === "cards");
            const result = run(...bindings);
            (Array.isArray(result) ? result : result ? [result] : []).forEach(record);
            return result;
          });
        }
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...bindings) {
          reads.cardQueries += Number(table === "cards");
          for (const row of iterate(...bindings)) {
            record(row);
            yield row;
          }
          return undefined;
        });
        return statement;
      });
      return db;
    },
  };
});

const backends: SqliteWorkerBackend<LogbookOperations>[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all(backends.splice(0).map((backend) => Promise.resolve(backend.close())));
    } finally {
      vi.restoreAllMocks();
      batchReads.length = 0;
      cleanup();
    }
  }),
);
const day = "2026-07-03";

function openBackend() {
  const dataDir = tempDirs.make("logbook-read-budget-");
  const databasePath = path.join(dataDir, "logbook.sqlite");
  const backend = createSqliteWorkerBackend({ dataDir }, { databasePath });
  backends.push(backend);
  return {
    backend,
    check: (command: Parameters<typeof backend.execute>[0]) => expect(backend.execute(command)),
    databasePath,
    status: (input: Omit<LogbookOperations["setBatchStatus"]["input"], "batchId">) =>
      backend.execute({ type: "setBatchStatus", input: { batchId: 1, ...input } }),
    latest: () => backend.execute({ type: "latestBatch", input: undefined }),
  };
}

describe("Logbook native statement and read budgets", () => {
  it("polls only pending batches in timestamp/id order without sorting historical rows", () => {
    const { backend, databasePath, check } = openBackend();
    {
      using writer = new DatabaseSync(databasePath);
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
    }
    for (const id of [1002, 1003, 1001]) {
      check({ type: "nextPendingBatch", input: undefined }).toMatchObject({
        id,
        status: "pending",
      });
      backend.execute({ type: "setBatchStatus", input: { batchId: id, status: "done" } });
    }
    check({ type: "nextPendingBatch", input: undefined }).toBeNull();
    expect(batchReads).toHaveLength(4);
    for (const plan of batchReads) {
      expect(plan).toEqual(
        expect.arrayContaining([expect.stringContaining("idx_logbook_batches_pending")]),
      );
      expect(plan.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);
      expect(plan).not.toContain("SCAN batches");
    }
  });

  it("clears stale errors while retaining or replacing the batch model", () => {
    const { backend, status, latest, check } = openBackend();
    const id = insertCandidate(backend, 1);
    assert(typeof id === "number");
    backend.execute({ type: "createBatch", input: batchInput([id]) });
    status({ status: "error", error: "First failure", model: "synthetic/first" });
    status({ status: "running", error: "Warmup status" });
    status({ status: "pending" });
    expect(latest()).toMatchObject({
      status: "pending",
      error: undefined,
      model: "synthetic/first",
    });
    status({ status: "done", model: "synthetic/second" });

    expect(latest()).toMatchObject({
      status: "done",
      error: undefined,
      model: "synthetic/second",
    });
    status({ status: "running" });
    backend.execute({ type: "resetRunningBatches", input: undefined });
    expect(latest()).toMatchObject({ status: "pending", model: "synthetic/second" });
    status({ status: "error", error: "retry" });
    check({ type: "resetErrorBatches", input: undefined }).toBe(1);
    check({ type: "resetErrorBatches", input: undefined }).toBe(0);
    expect(latest()).toMatchObject({ status: "pending", error: undefined });
  });

  it("hydrates timeline cards once and counts cards without hydrating their payloads", () => {
    const { backend, check } = openBackend();
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
    Object.assign(reads, { cardQueries: 0, cardRows: 0 });
    check({ type: "timelineForDay", input: { day } }).toMatchObject({
      cards: drafts.map((draft) => expect.objectContaining(draft)),
      stats: { trackedMs: 8 * 60_000 },
    });
    expect(reads).toMatchObject({ cardQueries: 1, cardRows: 8 });

    Object.assign(reads, { cardQueries: 0, cardRows: 0 });
    check({ type: "countCardsForDay", input: { day } }).toBe(8);
    expect(reads).toMatchObject({ cardQueries: 1, cardRows: 0 });
  });

  it("reads at most 200 observations with stable timestamp ties", () => {
    const { backend, check } = openBackend();
    const frameId = insertCandidate(backend, 1);
    assert(typeof frameId === "number", "Expected a frame id from the native backend");
    const batchId = backend.execute({
      type: "createBatch",
      input: batchInput([frameId], 0, Number.MAX_SAFE_INTEGER),
    });
    assert(typeof batchId === "number", "Expected a batch id from the native backend");
    const segments = Array.from({ length: 201 }, (_, index) => ({
      startMs: 1 + Math.floor(index / 3) * 1000,
      endMs: 1001 + Math.floor(index / 3) * 1000,
      text: `Observation ${index} 🦞`,
    }));
    backend.execute({ type: "replaceObservations", input: { batchId, day, segments } });
    reads.observationRows = 0;
    check({
      type: "observationsInRange",
      input: { day, startMs: 0, endMs: Number.MAX_SAFE_INTEGER, tailLimit: 200 },
    }).toHaveLength(200);
    expect(reads.observationRows).toBe(200);
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
        idle,
      }),
    });
  }

  it("selects ordered pending and range metadata without decoding unused text or narrowing full readers", () => {
    const { backend, check } = openBackend();
    const times = [3000, 1000, 1000, 2000, 500, 750];
    times.forEach((time, index) => insertCandidate(backend, time, index === 4));
    check({ type: "lastFrame", input: undefined }).toEqual({
      capturedAtMs: 3000,
      contentHash: "synthetic",
    });
    backend.execute({ type: "createBatch", input: batchInput([6], 750, 751) });
    const expected = [2, 3, 4, 1].map((id) => ({ id, capturedAtMs: times[id - 1] }));
    for (const limit of [0, 2, 10]) {
      Object.assign(reads, { frameRows: 0, frameTextBytes: 0 });
      const pending = backend.execute({ type: "unbatchedActiveFrames", input: { limit } });
      expect(reads.frameRows).toBe(Math.min(limit, expected.length));
      expect.soft(reads.frameTextBytes).toBe(0);
      expect(pending).toEqual(expected.slice(0, limit));
    }

    Object.assign(reads, { frameRows: 0, frameTextBytes: 0 });
    const range = backend.execute({ type: "framesInRange", input: { startMs: 500, endMs: 3000 } });
    expect(reads.frameRows).toBe(5);
    expect.soft(reads.frameTextBytes).toBe(0);
    expect(range).toEqual(
      [5, 6, 2, 3, 4].map((id) => ({ id, capturedAtMs: times[id - 1], idle: id === 5 })),
    );

    const payload = { day, path: `captures/${"nested/".repeat(12)}750.jpg` };
    check({ type: "frameById", input: { id: 6 } }).toMatchObject(payload);
    check({ type: "sampledBatchFrames", input: { batchId: 1 } }).toEqual([
      expect.objectContaining(payload),
    ]);
    expect(reads.frameTextBytes).toBeGreaterThan(0);
  });

  it.each([0, 120])(
    "selects keyframes without reading path/day payloads for %i candidates",
    (count) => {
      const { backend, check } = openBackend();
      for (let index = 0; index < count; index += 1) {
        insertCandidate(backend, Math.floor(index / 2) * 1000);
      }
      insertCandidate(backend, -1);
      insertCandidate(backend, 120_000);
      Object.assign(reads, { frameRows: 0, frameTextBytes: 0 });
      backend.execute({
        type: "replaceCardsInWindow",
        input: { day, startMs: 0, endMs: 120_000, drafts: keyframeDrafts },
      });
      const expectedIds = count === 0 ? [undefined, undefined] : [41, 119];
      check({ type: "cardsForDay", input: { day } }).toEqual(
        expectedIds.map((keyframeId) => expect.objectContaining({ keyframeId })),
      );
      expect(reads.frameRows).toBe(count);
      expect.soft(reads.frameTextBytes).toBe(0);
    },
  );
});
