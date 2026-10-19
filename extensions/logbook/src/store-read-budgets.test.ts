import assert from "node:assert/strict";
import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openNodeSqliteDatabase,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogbookFrameInput, LogbookOperations } from "./store-contract.js";
import { createSqliteWorkerBackend } from "./store.worker.js";

const reads = vi.hoisted(() => ({
  cardQueries: 0,
  cardRows: 0,
  observationRows: 0,
  frameRows: 0,
  frameTextBytes: 0,
}));
const preparations = vi.hoisted(() => new Map<string, number>());
const batchReads = vi.hoisted(() => [] as string[][]);
const schemaStatements = vi.hoisted(() => [] as string[]);
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-worker-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const db = actual.openNodeSqliteDatabase(...args);
      const prepare = db.prepare.bind(db);
      const recordSchema = (sql: string) => {
        if (
          /user_version|schema_version|sqlite_schema|sqlite_master|pragma_table|CREATE\s+(?:TABLE|INDEX)/i.test(
            sql,
          )
        ) {
          schemaStatements.push(sql);
        }
      };
      const exec = db.exec.bind(db);
      vi.spyOn(db, "exec").mockImplementation((sql) => {
        recordSchema(sql);
        exec(sql);
      });
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        recordSchema(sql);
        const statement = prepare(sql);
        if (/^\s*(?:insert into "(?:frames|standups)"|update "batches")/i.test(sql)) {
          preparations.set(sql, (preparations.get(sql) ?? 0) + 1);
        }
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
            for (const value of Object.values(row)) {
              if (typeof value === "string") {
                reads.frameTextBytes += Buffer.byteLength(value);
              }
            }
          }
        };
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation((...bindings) => {
          reads.cardQueries += Number(table === "cards");
          const row = get(...bindings);
          if (row) {
            record(row);
          }
          return row;
        });
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...bindings) => {
          reads.cardQueries += Number(table === "cards");
          const rows = all(...bindings);
          rows.forEach(record);
          return rows;
        });
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
      preparations.clear();
      batchReads.length = 0;
      schemaStatements.length = 0;
      cleanup();
    }
  }),
);
const day = "2026-07-03";
const frameFields = { day, screenIndex: 0, width: 640, height: 480, byteSize: 10 };
const fullDay = { day, startMs: 0, endMs: Number.MAX_SAFE_INTEGER };
const cardContent = {
  summary: "Summary",
  detail: "Detailed activity",
  category: "coding",
  distractions: [],
};

it("reuses live schema admission on reopen and validates a replacement physical database", async () => {
  const dataDir = tempDirs.make("logbook-schema-admission-");
  const databasePath = path.join(dataDir, "logbook.sqlite");
  // Keep the original physical store admitted through reopen and pathname replacement.
  using owner = openNodeSqliteDatabase(databasePath);
  expect(owner.isOpen).toBe(true);
  for (let opened = 0; opened < 3; opened += 1) {
    schemaStatements.length = 0;
    const backend = createSqliteWorkerBackend({ dataDir }, { databasePath });
    try {
      if (opened === 1) {
        expect(schemaStatements).toEqual([]);
      } else {
        expect(schemaStatements.length).toBeGreaterThan(0);
      }
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
  return { backend, databasePath, run: backend.execute.bind(backend) };
}

describe("Logbook native statement and read budgets", () => {
  it("polls only pending batches in timestamp/id order without sorting historical rows", () => {
    const { run, databasePath } = openBackend();
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
      expect(run({ type: "nextPendingBatch", input: undefined })).toMatchObject({
        id,
        status: "pending",
      });
      run({ type: "setBatchStatus", input: { batchId: id, status: "done" } });
    }
    expect(run({ type: "nextPendingBatch", input: undefined })).toBeNull();
    expect(batchReads).toHaveLength(4);
    for (const plan of batchReads) {
      expect(plan).toEqual(
        expect.arrayContaining([expect.stringContaining("idx_logbook_batches_pending")]),
      );
      expect(plan.some((detail) => detail.includes("TEMP B-TREE"))).toBe(false);
      expect(plan).not.toContain("SCAN batches");
    }
  });

  it("reuses native write statements with fresh optional values and model coalescing", () => {
    const { run } = openBackend();
    const firstFrame = { capturedAtMs: 1, path: "first.jpg", ...frameFields, idle: false };
    const warmupFrame = { ...firstFrame, path: "warmup.jpg" };
    const secondFrame = {
      capturedAtMs: 2,
      day,
      path: "second.jpg",
      screenIndex: 1,
      width: undefined,
      height: undefined,
      byteSize: 20,
      idle: true,
    };
    const insert = (frame: Omit<LogbookFrameInput, "contentHash">, contentHash: string) =>
      run({ type: "insertFrame", input: { ...frame, contentHash } });
    const standup = (text: string, targetDay = day) =>
      run({ type: "saveStandup", input: { day: targetDay, text } });
    expect(insert(firstFrame, "first")).toBe(1);
    expect(run({ type: "createBatch", input: { day, startMs: 1, endMs: 2, frameIds: [1] } })).toBe(
      1,
    );
    standup("Initial standup");
    run({
      type: "setBatchStatus",
      input: { batchId: 1, status: "error", error: "First failure", model: "synthetic/first" },
    });
    // The native cache retains a query on its second execution.
    expect(insert(warmupFrame, "warmup")).toBe(2);
    standup("Warmup standup");
    run({
      type: "setBatchStatus",
      input: { batchId: 1, status: "running", error: "Warmup status" },
    });
    const warmed = new Map(preparations);
    expect([...warmed.values()]).toEqual([2, 2, 2]);

    expect(insert(secondFrame, "second")).toBe(3);
    standup("Revised standup 🦞");
    standup("Another day", "2026-07-04");
    run({ type: "setBatchStatus", input: { batchId: 1, status: "pending" } });
    expect(run({ type: "latestBatch", input: undefined })).toMatchObject({
      status: "pending",
      error: undefined,
      model: "synthetic/first",
    });
    run({
      type: "setBatchStatus",
      input: { batchId: 1, status: "done", model: "synthetic/second" },
    });

    expect(preparations).toEqual(warmed);
    [firstFrame, warmupFrame, secondFrame].forEach((frame, index) => {
      expect(run({ type: "frameById", input: { id: index + 1 } })).toMatchObject(frame);
    });
    expect(run({ type: "lastFrame", input: undefined })).toEqual({
      capturedAtMs: 2,
      contentHash: "second",
    });
    expect(run({ type: "getStandup", input: { day } })).toMatchObject({
      text: "Revised standup 🦞",
    });
    expect(run({ type: "getStandup", input: { day: "2026-07-04" } })).toMatchObject({
      text: "Another day",
    });
    expect(run({ type: "latestBatch", input: undefined })).toMatchObject({
      status: "done",
      error: undefined,
      model: "synthetic/second",
    });
  });

  it("hydrates timeline cards once and counts cards without hydrating their payloads", () => {
    const { run } = openBackend();
    const drafts = Array.from({ length: 8 }, (_, index) => ({
      day,
      startMs: index * 60_000,
      endMs: (index + 1) * 60_000,
      title: `Card ${index} 🦞`,
      ...cardContent,
    }));
    run({ type: "replaceCardsInWindow", input: { ...fullDay, drafts } });
    Object.assign(reads, { cardQueries: 0, cardRows: 0 });
    expect(run({ type: "timelineForDay", input: { day } })).toMatchObject({
      cards: drafts.map((draft) => expect.objectContaining(draft)),
      stats: { trackedMs: 8 * 60_000 },
    });
    expect(reads).toMatchObject({ cardQueries: 1, cardRows: 8 });

    Object.assign(reads, { cardQueries: 0, cardRows: 0 });
    expect(run({ type: "countCardsForDay", input: { day } })).toBe(8);
    expect(reads).toMatchObject({ cardQueries: 1, cardRows: 0 });
  });

  it("reads at most 200 observations with stable timestamp ties", () => {
    const { backend, run } = openBackend();
    const frameId = insertCandidate(backend, 1);
    assert(typeof frameId === "number", "Expected a frame id from the native backend");
    const batchId = run({ type: "createBatch", input: { ...fullDay, frameIds: [frameId] } });
    assert(typeof batchId === "number", "Expected a batch id from the native backend");
    const segments = Array.from({ length: 201 }, (_, index) => ({
      startMs: 1 + Math.floor(index / 3) * 1000,
      endMs: 1001 + Math.floor(index / 3) * 1000,
      text: `Observation ${index} 🦞`,
    }));
    run({ type: "replaceObservations", input: { batchId, day, segments } });
    reads.observationRows = 0;
    expect(run({ type: "observationsInRange", input: { ...fullDay, tailLimit: 200 } })).toEqual(
      segments
        .map((segment, index) => Object.assign({ id: index + 1, batchId, day }, segment))
        .slice(-200),
    );
    expect(reads.observationRows).toBe(200);
  });
  const keyframeDrafts = [0, 40_000].map((startMs) =>
    Object.assign({}, cardContent, {
      day,
      startMs,
      endMs: startMs + 40_000,
      title: `Card ${startMs}`,
      detail: "",
    }),
  );
  function insertCandidate(
    backend: SqliteWorkerBackend<LogbookOperations>,
    capturedAtMs: number,
    idle = false,
  ) {
    return backend.execute({
      type: "insertFrame",
      input: {
        capturedAtMs,
        path: `captures/${"nested/".repeat(12)}${capturedAtMs}.jpg`,
        ...frameFields,
        contentHash: "synthetic",
        idle,
      },
    });
  }

  it("selects ordered pending and range metadata without decoding unused text or narrowing full readers", () => {
    const { backend, run } = openBackend();
    insertCandidate(backend, 3000);
    insertCandidate(backend, 1000);
    insertCandidate(backend, 1000);
    insertCandidate(backend, 2000);
    insertCandidate(backend, 500, true);
    insertCandidate(backend, 750);
    run({ type: "createBatch", input: { day, startMs: 750, endMs: 751, frameIds: [6] } });
    const expected = [
      { id: 2, capturedAtMs: 1000 },
      { id: 3, capturedAtMs: 1000 },
      { id: 4, capturedAtMs: 2000 },
      { id: 1, capturedAtMs: 3000 },
    ];
    for (const limit of [0, 2, 10]) {
      reads.frameRows = 0;
      reads.frameTextBytes = 0;
      const pending = run({ type: "unbatchedActiveFrames", input: { limit } });
      expect(reads.frameRows).toBe(Math.min(limit, expected.length));
      expect.soft(reads.frameTextBytes).toBe(0);
      expect(pending).toEqual(expected.slice(0, limit));
    }

    reads.frameRows = 0;
    reads.frameTextBytes = 0;
    const range = run({ type: "framesInRange", input: { startMs: 500, endMs: 3000 } });
    expect(reads.frameRows).toBe(5);
    expect.soft(reads.frameTextBytes).toBe(0);
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
      path: `captures/${"nested/".repeat(12)}750.jpg`,
      ...frameFields,
      idle: false,
    };
    expect(run({ type: "frameById", input: { id: 6 } })).toEqual(fullFrame);
    expect(run({ type: "sampledBatchFrames", input: { batchId: 1 } })).toEqual([fullFrame]);
    expect(reads.frameTextBytes).toBeGreaterThan(0);
  });

  it.each([0, 120])(
    "selects keyframes without reading path/day payloads for %i candidates",
    (count) => {
      const { backend, run } = openBackend();
      for (let index = 0; index < count; index += 1) {
        insertCandidate(backend, Math.floor(index / 2) * 1000);
      }
      insertCandidate(backend, -1);
      insertCandidate(backend, 120_000);
      reads.frameRows = 0;
      reads.frameTextBytes = 0;
      run({
        type: "replaceCardsInWindow",
        input: { day, startMs: 0, endMs: 120_000, drafts: keyframeDrafts, selectKeyframes: true },
      });
      const expectedIds = count === 0 ? [undefined, undefined] : [41, 119];
      expect(run({ type: "cardsForDay", input: { day } })).toEqual(
        keyframeDrafts.map((draft, index) =>
          expect.objectContaining(Object.assign({}, draft, { keyframeId: expectedIds[index] })),
        ),
      );
      expect(reads.frameRows).toBe(count);
      expect.soft(reads.frameTextBytes).toBe(0);
    },
  );
});
