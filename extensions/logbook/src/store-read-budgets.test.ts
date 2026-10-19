import assert from "node:assert/strict";
import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openNodeSqliteDatabase,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { LogbookOperations } from "./store-contract.js";
import { createSqliteWorkerBackend } from "./store.worker.js";

type ReadKind = "cards" | "cardCount" | "observations" | "frames";
const trackers = vi.hoisted(
  () => new Map<string, ReturnType<typeof trackSqliteStatementExecutions<ReadKind>>>(),
);
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
      const schemaPattern =
        /user_version|schema_version|sqlite_schema|sqlite_master|pragma_table|CREATE\s+(?:TABLE|INDEX)/i;
      const recordSchema = (sql: string) => schemaPattern.test(sql) && schemaStatements.push(sql);
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
        return statement;
      });
      const tracker = trackSqliteStatementExecutions(
        db,
        ["cards", "cardCount", "observations", "frames"],
        (sql) => {
          const table = /\bfrom\s+"?(cards|observations|frames)\b/i.exec(sql)?.[1];
          if (table === "cards") {
            return /\bcount\s*\(/i.test(sql) ? "cardCount" : "cards";
          }
          return table === "observations" || table === "frames" ? table : null;
        },
      );
      trackers.set(args[0], tracker);
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
      for (const tracker of trackers.values()) {
        tracker.restore();
      }
      trackers.clear();
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
const cardContent = { summary: "s", detail: "d", category: "coding", distractions: [] };
const makeDraft = (startMs: number, endMs: number, title: string, detail = "d") =>
  Object.assign({}, cardContent, { day, startMs, endMs, title, detail });

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
  const reads = trackers.get(databasePath);
  assert(reads, "Expected SQLite read instrumentation");
  return { databasePath, run: backend.execute.bind(backend), reads };
}

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
  const read = (type: "latestBatch" | "lastFrame") => run({ type, input: undefined });
  const firstFrame = { capturedAtMs: 1, path: "first.jpg", ...frameFields, idle: false };
  const warmupFrame = { ...firstFrame, path: "warmup.jpg" };
  const secondFrame = {
    ...firstFrame,
    capturedAtMs: 2,
    path: "second.jpg",
    screenIndex: 1,
    width: undefined,
    height: undefined,
    byteSize: 20,
    idle: true,
  };
  const rounds = [
    [firstFrame, "first", "Initial", { status: "error", error: "first", model: "m1" }],
    [warmupFrame, "warmup", "Warm", { status: "running", error: "warmup" }],
    [secondFrame, "second", "Revised 🦞", { status: "pending" }],
  ] as const;
  let warmed = new Map<string, number>();
  rounds.forEach(([frame, contentHash, text, status], index) => {
    expect(run({ type: "insertFrame", input: { ...frame, contentHash } })).toBe(index + 1);
    if (index === 0) {
      expect(
        run({ type: "createBatch", input: { day, startMs: 1, endMs: 2, frameIds: [1] } }),
      ).toBe(1);
    }
    run({ type: "saveStandup", input: { day, text } });
    if (index === 2) {
      run({ type: "saveStandup", input: { day: "2026-07-04", text: "Another day" } });
    }
    run({ type: "setBatchStatus", input: { batchId: 1, ...status } });
    if (index === 1) {
      // The native cache retains a query on its second execution.
      warmed = new Map(preparations);
      expect([...warmed.values()]).toEqual([2, 2, 2]);
    }
  });
  expect(read("latestBatch")).toMatchObject({ status: "pending", error: undefined, model: "m1" });
  run({ type: "setBatchStatus", input: { batchId: 1, status: "done", model: "m2" } });
  expect(preparations).toEqual(warmed);
  rounds.forEach(([frame], index) =>
    expect(run({ type: "frameById", input: { id: index + 1 } })).toMatchObject(frame),
  );
  expect(read("lastFrame")).toEqual({ capturedAtMs: 2, contentHash: "second" });
  expect(run({ type: "getStandup", input: { day } })).toMatchObject({ text: "Revised 🦞" });
  expect(run({ type: "getStandup", input: { day: "2026-07-04" } })).toMatchObject({
    text: "Another day",
  });
  expect(read("latestBatch")).toMatchObject({ status: "done", error: undefined, model: "m2" });
});

it("hydrates timeline cards once and counts cards without hydrating their payloads", () => {
  const { run, reads } = openBackend();
  const drafts = Array.from({ length: 8 }, (_, i) =>
    makeDraft(i * 60_000, (i + 1) * 60_000, `Card ${i} 🦞`),
  );
  run({ type: "replaceCardsInWindow", input: { ...fullDay, drafts } });
  Object.assign(reads.counts, { cards: 0, cardCount: 0 });
  reads.rowCounts.cards = 0;
  expect(run({ type: "timelineForDay", input: { day } })).toMatchObject({
    cards: drafts.map((draft) => expect.objectContaining(draft)),
    stats: { trackedMs: 8 * 60_000 },
  });
  expect([reads.counts.cards + reads.counts.cardCount, reads.rowCounts.cards]).toEqual([1, 8]);

  Object.assign(reads.counts, { cards: 0, cardCount: 0 });
  reads.rowCounts.cards = 0;
  expect(run({ type: "countCardsForDay", input: { day } })).toBe(8);
  expect([reads.counts.cards + reads.counts.cardCount, reads.rowCounts.cards]).toEqual([1, 0]);
});

it("reads at most 200 observations with stable timestamp ties", () => {
  const { run, reads } = openBackend();
  const frameId = insertCandidate(run, 1);
  assert(typeof frameId === "number", "Expected a frame id from the native backend");
  const batchId = run({ type: "createBatch", input: { ...fullDay, frameIds: [frameId] } });
  assert(typeof batchId === "number", "Expected a batch id from the native backend");
  const segments = Array.from({ length: 201 }, (_, index) => ({
    startMs: 1 + Math.floor(index / 3) * 1000,
    endMs: 1001 + Math.floor(index / 3) * 1000,
    text: `Observation ${index} 🦞`,
  }));
  run({ type: "replaceObservations", input: { batchId, day, segments } });
  reads.rowCounts.observations = 0;
  expect(run({ type: "observationsInRange", input: { ...fullDay, tailLimit: 200 } })).toEqual(
    segments
      .map((segment, index) => Object.assign({ id: index + 1, batchId, day }, segment))
      .slice(-200),
  );
  expect(reads.rowCounts.observations).toBe(200);
});
const keyframeDrafts = [0, 40_000].map((startMs) =>
  makeDraft(startMs, startMs + 40_000, `Card ${startMs}`, ""),
);
function insertCandidate(
  run: SqliteWorkerBackend<LogbookOperations>["execute"],
  capturedAtMs: number,
  idle = false,
) {
  return run({
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
  const { run, reads } = openBackend();
  insertCandidate(run, 3000);
  insertCandidate(run, 1000);
  insertCandidate(run, 1000);
  insertCandidate(run, 2000);
  insertCandidate(run, 500, true);
  insertCandidate(run, 750);
  run({ type: "createBatch", input: { day, startMs: 750, endMs: 751, frameIds: [6] } });
  const expected = [
    { id: 2, capturedAtMs: 1000 },
    { id: 3, capturedAtMs: 1000 },
    { id: 4, capturedAtMs: 2000 },
    { id: 1, capturedAtMs: 3000 },
  ];
  for (const limit of [0, 2, 10]) {
    reads.rowCounts.frames = 0;
    reads.textBytes.frames = 0;
    const pending = run({ type: "unbatchedActiveFrames", input: { limit } });
    expect(reads.rowCounts.frames).toBe(Math.min(limit, expected.length));
    expect.soft(reads.textBytes.frames).toBe(0);
    expect(pending).toEqual(expected.slice(0, limit));
  }

  reads.rowCounts.frames = 0;
  reads.textBytes.frames = 0;
  const range = run({ type: "framesInRange", input: { startMs: 500, endMs: 3000 } });
  expect(reads.rowCounts.frames).toBe(5);
  expect.soft(reads.textBytes.frames).toBe(0);
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
  expect(reads.textBytes.frames).toBeGreaterThan(0);
});

it.each([0, 120])(
  "selects keyframes without reading path/day payloads for %i candidates",
  (count) => {
    const { run, reads } = openBackend();
    for (let index = 0; index < count; index += 1) {
      insertCandidate(run, Math.floor(index / 2) * 1000);
    }
    insertCandidate(run, -1);
    insertCandidate(run, 120_000);
    reads.rowCounts.frames = 0;
    reads.textBytes.frames = 0;
    run({
      type: "replaceCardsInWindow",
      input: {
        day,
        startMs: 0,
        endMs: 120_000,
        drafts: keyframeDrafts,
        selectKeyframes: true,
      },
    });
    const expectedIds = count === 0 ? [undefined, undefined] : [41, 119];
    expect(run({ type: "cardsForDay", input: { day } })).toEqual(
      keyframeDrafts.map((draft, index) =>
        expect.objectContaining(Object.assign({}, draft, { keyframeId: expectedIds[index] })),
      ),
    );
    expect(reads.rowCounts.frames).toBe(count);
    expect.soft(reads.textBytes.frames).toBe(0);
  },
);
