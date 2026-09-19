import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteWorkerBackend } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogbookOperations } from "./store-contract.js";
import { createSqliteWorkerBackend } from "./store.worker.js";

const reads = vi.hoisted(() => ({
  cardQueries: 0,
  cardRows: 0,
  observationRows: 0,
  frameRows: 0,
  frameTextBytes: 0,
}));
const preparations = vi.hoisted(() => new Map<string, number>());
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-worker-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const db = actual.openNodeSqliteDatabase(...args);
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (/^\s*(?:insert into "(?:frames|standups)"|update "batches")/i.test(sql)) {
          preparations.set(sql, (preparations.get(sql) ?? 0) + 1);
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
  return { backend, databasePath };
}

describe("Logbook native statement and read budgets", () => {
  it("reuses native write statements with fresh optional values and model coalescing", () => {
    const { backend } = openBackend();
    const firstFrame = {
      capturedAtMs: 1,
      day,
      path: "first.jpg",
      screenIndex: 0,
      width: 640,
      height: 480,
      byteSize: 10,
      contentHash: "first",
      idle: false,
    };
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
    const warmed = new Map(preparations);
    expect([...warmed.values()]).toEqual([2, 2, 2]);

    expect(
      backend.execute({
        type: "insertFrame",
        input: {
          capturedAtMs: 2,
          day,
          path: "second.jpg",
          screenIndex: 1,
          byteSize: 20,
          contentHash: "second",
          idle: true,
        },
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

    expect(preparations).toEqual(warmed);
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

  it("hydrates timeline cards once and counts cards without hydrating their payloads", () => {
    const { backend } = openBackend();
    const drafts = Array.from({ length: 8 }, (_, index) => ({
      day,
      startMs: index * 60_000,
      endMs: (index + 1) * 60_000,
      title: `Card ${index} 🦞`,
      summary: "Summary",
      detail: "Detailed activity",
      category: "coding",
      distractions: [],
    }));
    backend.execute({
      type: "replaceCardsInWindow",
      input: { day, startMs: 0, endMs: Number.MAX_SAFE_INTEGER, drafts },
    });
    reads.cardQueries = 0;
    reads.cardRows = 0;
    expect(backend.execute({ type: "timelineForDay", input: { day } })).toMatchObject({
      cards: drafts.map((draft) => expect.objectContaining(draft)),
      stats: { trackedMs: 8 * 60_000 },
    });
    expect(reads.cardQueries).toBe(1);
    expect(reads.cardRows).toBe(8);

    reads.cardQueries = 0;
    reads.cardRows = 0;
    expect(backend.execute({ type: "countCardsForDay", input: { day } })).toBe(8);
    expect(reads.cardQueries).toBe(1);
    expect(reads.cardRows).toBe(0);
  });

  it.each([0, 199, 200, 201])(
    "reads at most 200 of %i observations with stable timestamp ties",
    (count) => {
      const { backend } = openBackend();
      const frameId = backend.execute({
        type: "insertFrame",
        input: {
          capturedAtMs: 1,
          day,
          path: "synthetic.jpg",
          screenIndex: 0,
          byteSize: 0,
          contentHash: "synthetic",
          idle: false,
        },
      });
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
      const segments = Array.from({ length: count }, (_, index) => ({
        startMs: 1 + Math.floor(index / 3) * 1000,
        endMs: 1001 + Math.floor(index / 3) * 1000,
        text: `Observation ${index} 🦞`,
      }));
      backend.execute({ type: "replaceObservations", input: { batchId, day, segments } });
      reads.observationRows = 0;
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
      expect(reads.observationRows).toBe(Math.min(count, 200));
    },
  );
  const keyframeDrafts = [
    {
      day,
      startMs: 0,
      endMs: 40_000,
      title: "First card",
      summary: "Summary",
      detail: "",
      category: "coding",
      distractions: [],
    },
    {
      day,
      startMs: 40_000,
      endMs: 80_000,
      title: "Second card",
      summary: "Summary",
      detail: "",
      category: "coding",
      distractions: [],
    },
  ];
  function insertCandidate(
    backend: SqliteWorkerBackend<LogbookOperations>,
    capturedAtMs: number,
    idle = false,
  ) {
    return backend.execute({
      type: "insertFrame",
      input: {
        capturedAtMs,
        day,
        path: `captures/${"nested/".repeat(12)}${capturedAtMs}.jpg`,
        screenIndex: 0,
        width: 640,
        height: 480,
        byteSize: 10,
        contentHash: "synthetic",
        idle,
      },
    });
  }

  it("selects ordered pending frames without decoding unused text or narrowing full readers", () => {
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
      reads.frameRows = 0;
      reads.frameTextBytes = 0;
      const pending = backend.execute({ type: "unbatchedActiveFrames", input: { limit } });
      expect(reads.frameRows).toBe(Math.min(limit, expected.length));
      expect.soft(reads.frameTextBytes).toBe(0);
      expect(pending).toEqual(expected.slice(0, limit));
    }

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
    expect(backend.execute({ type: "framesInRange", input: { startMs: 750, endMs: 751 } })).toEqual(
      [fullFrame],
    );
    expect(backend.execute({ type: "batchFrames", input: { batchId: 1 } })).toEqual([fullFrame]);
    expect(backend.execute({ type: "sampledBatchFrames", input: { batchId: 1 } })).toEqual([
      fullFrame,
    ]);
    expect(reads.frameTextBytes).toBeGreaterThan(0);
  });

  it.each([0, 1, 120])(
    "selects keyframes without reading path/day payloads for %i candidates",
    (count) => {
      const { backend } = openBackend();
      for (let index = 0; index < count; index += 1) {
        insertCandidate(backend, Math.floor(index / 2) * 1000);
      }
      insertCandidate(backend, -1);
      insertCandidate(backend, 120_000);
      reads.frameRows = 0;
      reads.frameTextBytes = 0;
      backend.execute({
        type: "replaceCardsInWindow",
        input: { day, startMs: 0, endMs: 120_000, drafts: keyframeDrafts, selectKeyframes: true },
      });
      const expectedIds = count === 0 ? [undefined, undefined] : count === 1 ? [1, 1] : [41, 119];
      expect(backend.execute({ type: "cardsForDay", input: { day } })).toEqual(
        keyframeDrafts.map((draft, index) =>
          expect.objectContaining(Object.assign({}, draft, { keyframeId: expectedIds[index] })),
        ),
      );
      expect(reads.frameRows).toBe(count);
      expect.soft(reads.frameTextBytes).toBe(0);
      const frames = backend.execute({
        type: "framesInRange",
        input: { startMs: 0, endMs: 120_000 },
      });
      expect(frames).toHaveLength(count);
      if (count > 0) {
        expect(frames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: 1,
              capturedAtMs: 0,
              day,
              path: `captures/${"nested/".repeat(12)}0.jpg`,
              width: 640,
              height: 480,
              byteSize: 10,
              screenIndex: 0,
              idle: false,
            }),
          ]),
        );
      }
    },
  );

  it.each([
    { column: "screen_index", emptyDrafts: false, value: 9007199254740992n },
    { column: "width", emptyDrafts: true, value: -9007199254740992n },
    { column: "height", emptyDrafts: false, value: 9007199254740992n },
    { column: "byte_size", emptyDrafts: true, value: -9007199254740992n },
  ] as const)(
    "retains native $column overflow rejection in frame readers and prior cards (empty drafts=$emptyDrafts)",
    ({ column, emptyDrafts, value }) => {
      const { backend, databasePath } = openBackend();
      insertCandidate(backend, 1000);
      backend.execute({
        type: "replaceCardsInWindow",
        input: { day, startMs: 0, endMs: 120_000, drafts: keyframeDrafts },
      });
      const before = backend.execute({ type: "cardsForDay", input: { day } });
      const writer = new DatabaseSync(databasePath);
      try {
        writer.prepare(`UPDATE frames SET ${column} = ? WHERE id = 1`).run(value);
      } finally {
        writer.close();
      }
      let originalError: unknown;
      try {
        backend.execute({ type: "framesInRange", input: { startMs: 0, endMs: 120_000 } });
      } catch (error) {
        originalError = error;
      }
      if (!(originalError instanceof Error)) {
        throw new Error("Expected the full frame reader to reject the unsafe integer fixture");
      }
      expect(originalError).toMatchObject({ code: "ERR_OUT_OF_RANGE" });
      let pendingError: unknown;
      try {
        backend.execute({ type: "unbatchedActiveFrames", input: { limit: 1 } });
      } catch (error) {
        pendingError = error;
      }
      expect(pendingError).toBeInstanceOf(Error);
      expect(pendingError).toMatchObject({
        code: "ERR_OUT_OF_RANGE",
        name: originalError.name,
        message: originalError.message,
      });
      let replacementError: unknown;
      try {
        backend.execute({
          type: "replaceCardsInWindow",
          input: {
            day,
            startMs: 0,
            endMs: 120_000,
            drafts: emptyDrafts ? [] : keyframeDrafts,
            selectKeyframes: true,
          },
        });
      } catch (error) {
        replacementError = error;
      }
      expect(replacementError).toBeInstanceOf(Error);
      expect(replacementError).toMatchObject({
        code: "ERR_OUT_OF_RANGE",
        name: originalError.name,
        message: originalError.message,
      });
      expect(backend.execute({ type: "cardsForDay", input: { day } })).toEqual(before);
    },
  );
});
