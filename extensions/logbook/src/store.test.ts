import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dayKeyFor } from "./day.js";
import { LogbookStore } from "./store.js";
import type { LogbookCardDraft } from "./types.js";

const workerModuleUrl = new URL("./store.worker.ts", import.meta.url);
const DAY = "2026-07-03";

function queryPlanDetails(database: DatabaseSync, sql: string): string[] {
  return (
    database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
      detail: string;
    }>
  ).map((row) => row.detail);
}

function draft(overrides: Partial<LogbookCardDraft> = {}): LogbookCardDraft {
  const base = new Date(`${DAY}T10:00:00`).getTime();
  return {
    day: DAY,
    startMs: base,
    endMs: base + 30 * 60_000,
    title: "Card",
    summary: "Summary",
    detail: "",
    category: "coding",
    appPrimary: "github.com",
    appSecondary: undefined,
    distractions: [],
    keyframeId: undefined,
    ...overrides,
  };
}

describe("LogbookStore", () => {
  let dir: string;
  let store: LogbookStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "logbook-store-"));
    store = await LogbookStore.open(dir, workerModuleUrl);
  });

  afterEach(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const insertFrame = async (capturedAtMs: number, opts?: { idle?: boolean; hash?: string }) => {
    const day = dayKeyFor(capturedAtMs);
    const filePath = store.frameFilePath(day, capturedAtMs);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "jpeg-bytes");
    return await store.insertFrame({
      capturedAtMs,
      day,
      path: filePath,
      screenIndex: 0,
      byteSize: 9,
      contentHash: opts?.hash ?? `hash-${capturedAtMs}`,
      idle: opts?.idle ?? false,
    });
  };

  it("tracks unbatched active frames and excludes idle ones", async () => {
    const t0 = Date.now();
    await insertFrame(t0);
    await insertFrame(t0 + 1000, { idle: true });
    await insertFrame(t0 + 2000);
    expect(await store.countUnbatchedActiveFrames()).toBe(2);
    const batchId = await store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 3000,
      frameIds: (await store.unbatchedActiveFrames(10)).map((frame) => frame.id),
    });
    expect(await store.countUnbatchedActiveFrames()).toBe(0);
    expect(await store.batchFrames(batchId)).toHaveLength(2);
  });

  it("refuses a hardlinked database with another frame root before bootstrapping that root", async () => {
    const capturedAtMs = Date.now();
    const frameId = await insertFrame(capturedAtMs);
    const otherRoot = path.join(dir, "another-root");
    mkdirSync(otherRoot);
    linkSync(path.join(dir, "logbook.sqlite"), path.join(otherRoot, "logbook.sqlite"));
    const [result] = await Promise.allSettled([LogbookStore.open(otherRoot, workerModuleUrl)]);
    try {
      expect(existsSync(path.join(otherRoot, "frames"))).toBe(false);
      expect(result).toMatchObject({
        status: "rejected",
        reason: { message: "SQLite database already belongs to another worker backend" },
      });
      expect(await store.frameById(frameId)).toMatchObject({
        id: frameId,
        capturedAtMs,
        path: store.frameFilePath(dayKeyFor(capturedAtMs), capturedAtMs),
      });
      expect(await store.countUnbatchedActiveFrames()).toBe(1);
    } finally {
      if (result.status === "fulfilled") {
        await result.value.close();
      }
    }
  });

  it("creates every owned table as STRICT with foreign keys enabled", () => {
    const database = new DatabaseSync(path.join(dir, "logbook.sqlite"), { readOnly: true });
    try {
      const ordinaryTables = database
        .prepare(
          `SELECT name, strict FROM pragma_table_list
           WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all();
      expect(ordinaryTables).toEqual([
        { name: "batches", strict: 1 },
        { name: "cards", strict: 1 },
        { name: "frames", strict: 1 },
        { name: "observations", strict: 1 },
        { name: "standups", strict: 1 },
      ]);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(database.prepare("PRAGMA foreign_key_list(observations)").all()).toContainEqual(
        expect.objectContaining({ table: "batches", on_delete: "CASCADE" }),
      );
      expect(database.prepare("PRAGMA foreign_key_list(cards)").all()).toContainEqual(
        expect.objectContaining({ table: "frames", on_delete: "SET NULL" }),
      );
    } finally {
      database.close();
    }
  });

  it.each([
    {
      operation: "batch frame reads",
      sql: "SELECT id FROM frames WHERE batch_id = 1 ORDER BY captured_at_ms ASC",
      expectedIndex: "idx_logbook_frames_batch",
      scannedTable: "frames",
      ordered: true,
    },
    {
      operation: "observation replacement",
      sql: "DELETE FROM observations WHERE batch_id = 1",
      expectedIndex: "idx_logbook_observations_batch",
      scannedTable: "observations",
      ordered: false,
    },
    {
      operation: "frame pruning foreign-key maintenance",
      sql: "DELETE FROM frames WHERE id = 1",
      expectedIndex: "idx_logbook_cards_keyframe",
      scannedTable: "cards",
      ordered: false,
    },
    {
      operation: "latest frame reads",
      sql: "SELECT id FROM frames ORDER BY captured_at_ms DESC LIMIT 1",
      expectedIndex: "idx_logbook_frames_captured_at",
      scannedTable: "frames",
      ordered: true,
    },
    {
      operation: "frame range reads",
      sql: "SELECT id FROM frames WHERE captured_at_ms >= 1 AND captured_at_ms < 2 ORDER BY captured_at_ms ASC",
      expectedIndex: "idx_logbook_frames_captured_at",
      scannedTable: "frames",
      ordered: true,
    },
  ])(
    "uses the supporting index for $operation",
    ({ sql, expectedIndex, scannedTable, ordered }) => {
      const database = new DatabaseSync(path.join(dir, "logbook.sqlite"), { readOnly: true });
      try {
        const plan = queryPlanDetails(database, sql);
        expect(plan).toEqual(expect.arrayContaining([expect.stringContaining(expectedIndex)]));
        expect(
          plan.some(
            (detail) => detail.startsWith(`SCAN ${scannedTable}`) && !detail.includes(" USING "),
          ),
        ).toBe(false);
        if (ordered) {
          expect(plan).not.toEqual(
            expect.arrayContaining([expect.stringContaining("USE TEMP B-TREE FOR ORDER BY")]),
          );
        }
      } finally {
        database.close();
      }
    },
  );

  it("restores missing schema-1 indexes on reopen without changing the version", async () => {
    await store.close();
    const databasePath = path.join(dir, "logbook.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP INDEX IF EXISTS idx_logbook_frames_captured_at;
      DROP INDEX IF EXISTS idx_logbook_frames_batch;
      DROP INDEX IF EXISTS idx_logbook_observations_batch;
      DROP INDEX IF EXISTS idx_logbook_cards_keyframe;
    `);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    database.close();

    store = await LogbookStore.open(dir, workerModuleUrl);

    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const indexes = reopened
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'index'
             AND name IN (
               'idx_logbook_frames_batch',
               'idx_logbook_frames_captured_at',
               'idx_logbook_observations_batch',
               'idx_logbook_cards_keyframe'
             )
           ORDER BY name`,
        )
        .all();
      expect(indexes).toEqual([
        { name: "idx_logbook_cards_keyframe" },
        { name: "idx_logbook_frames_batch" },
        { name: "idx_logbook_frames_captured_at" },
        { name: "idx_logbook_observations_batch" },
      ]);
      expect(reopened.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    } finally {
      reopened.close();
    }
  });

  it("rejects values that violate STRICT column types", () => {
    const database = new DatabaseSync(path.join(dir, "logbook.sqlite"));
    try {
      expect(() =>
        database
          .prepare("INSERT INTO standups (day, text, updated_ms) VALUES (?, ?, ?)")
          .run(DAY, "bad timestamp", "not-an-integer"),
      ).toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM standups").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("rolls back the whole batch when any frame is missing", async () => {
    const t0 = Date.now();
    const frameId = await insertFrame(t0);

    await expect(
      store.createBatch({
        day: dayKeyFor(t0),
        startMs: t0,
        endMs: t0 + 1000,
        frameIds: [frameId, 999_999],
      }),
    ).rejects.toThrow("Logbook frame 999999 is missing or already batched");

    expect(await store.latestBatch()).toBeNull();
    expect((await store.unbatchedActiveFrames(10)).map((frame) => frame.id)).toEqual([frameId]);
  });

  it("does not steal a frame from an existing batch", async () => {
    const t0 = Date.now();
    const firstFrame = await insertFrame(t0);
    const secondFrame = await insertFrame(t0 + 1000);
    const firstBatch = await store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 1000,
      frameIds: [firstFrame],
    });

    await expect(
      store.createBatch({
        day: dayKeyFor(t0),
        startMs: t0,
        endMs: t0 + 2000,
        frameIds: [firstFrame, secondFrame],
      }),
    ).rejects.toThrow(`Logbook frame ${firstFrame} is missing or already batched`);

    expect((await store.latestBatch())?.id).toBe(firstBatch);
    expect((await store.batchFrames(firstBatch)).map((frame) => frame.id)).toEqual([firstFrame]);
    expect((await store.unbatchedActiveFrames(10)).map((frame) => frame.id)).toEqual([secondFrame]);
  });

  it("rejects empty and duplicate frame claims without leaving a batch", async () => {
    const t0 = Date.now();
    await expect(
      store.createBatch({ day: DAY, startMs: t0, endMs: t0 + 1000, frameIds: [] }),
    ).rejects.toThrow("Logbook batch requires at least one frame");
    const frameId = await insertFrame(t0);
    await expect(
      store.createBatch({
        day: DAY,
        startMs: t0,
        endMs: t0 + 1000,
        frameIds: [frameId, frameId],
      }),
    ).rejects.toThrow(`Logbook frame ${frameId} is missing or already batched`);
    expect(await store.latestBatch()).toBeNull();
    expect(await store.countUnbatchedActiveFrames()).toBe(1);
  });

  it("resets running batches to pending on startup recovery", async () => {
    const t0 = Date.now();
    await insertFrame(t0);
    const batchId = await store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 1000,
      frameIds: [1],
    });
    await store.setBatchStatus(batchId, "running");
    await store.resetRunningBatches();
    expect((await store.nextPendingBatch())?.id).toBe(batchId);
  });

  it("replaces only cards overlapping the revision window", async () => {
    const base = new Date(`${DAY}T09:00:00`).getTime();
    await store.replaceCardsInWindow(DAY, base, base + 4 * 60 * 60_000, [
      draft({ startMs: base, endMs: base + 30 * 60_000, title: "Early" }),
      draft({ startMs: base + 60 * 60_000, endMs: base + 90 * 60_000, title: "Mid" }),
    ]);
    expect(
      await store.cardsForDay(DAY, { startMs: base + 30 * 60_000, endMs: base + 60 * 60_000 }),
    ).toEqual([]);
    expect(
      (
        await store.cardsForDay(DAY, { startMs: base + 50 * 60_000, endMs: base + 2 * 60 * 60_000 })
      ).map((card) => card.title),
    ).toEqual(["Mid"]);
    // Revise only the window covering "Mid"; "Early" must survive untouched.
    await store.replaceCardsInWindow(DAY, base + 50 * 60_000, base + 2 * 60 * 60_000, [
      draft({ startMs: base + 55 * 60_000, endMs: base + 95 * 60_000, title: "Mid revised" }),
    ]);
    const titles = (await store.cardsForDay(DAY)).map((card) => card.title);
    expect(titles).toEqual(["Early", "Mid revised"]);
  });

  it("round-trips distractions and computes day stats", async () => {
    const base = new Date(`${DAY}T10:00:00`).getTime();
    await store.replaceCardsInWindow(DAY, base, base + 60 * 60_000, [
      draft({
        distractions: [{ startMs: base + 5 * 60_000, endMs: base + 10 * 60_000, title: "Twitter" }],
      }),
      draft({ title: "Review", category: "review", appPrimary: undefined, appSecondary: "" }),
    ]);
    const database = new DatabaseSync(path.join(dir, "logbook.sqlite"));
    try {
      database.prepare("UPDATE cards SET distractions = ? WHERE title = ?").run("{", "Review");
    } finally {
      database.close();
    }
    const cards = await store.cardsForDay(DAY);
    expect(cards.map((card) => card.title)).toEqual(["Card", "Review"]);
    expect(cards[1]).toMatchObject({
      appPrimary: undefined,
      appSecondary: "",
      keyframeId: undefined,
      distractions: [],
    });
    expect(expectDefined(cards[0], "stored logbook card").distractions).toEqual([
      { startMs: base + 5 * 60_000, endMs: base + 10 * 60_000, title: "Twitter" },
    ]);
    const stats = (await store.timelineForDay(DAY)).stats;
    expect(stats.trackedMs).toBe(60 * 60_000);
    expect(stats.distractionMs).toBe(5 * 60_000);
    expect(stats.categories).toEqual([
      { category: "coding", ms: 30 * 60_000 },
      { category: "review", ms: 30 * 60_000 },
    ]);
    expect(expectDefined(stats.apps[0], "logbook app statistic").domain).toBe("github.com");
    expect(await store.countCardsForDay(DAY)).toBe(cards.length);
    expect(await store.countCardsForDay("2026-07-04")).toBe(0);
    expect(await store.timelineForDay("2026-07-04")).toEqual({
      day: "2026-07-04",
      cards: [],
      stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
    });
  });

  it("prunes old frame rows and files but keeps recent ones", async () => {
    const now = Date.now();
    const oldId = await insertFrame(now - 20 * 24 * 60 * 60_000);
    const newId = await insertFrame(now);
    const oldPath = (await store.frameById(oldId))?.path ?? "";
    expect(await store.pruneFrames(now - 14 * 24 * 60 * 60_000)).toBe(1);
    expect(await store.frameById(oldId)).toBeNull();
    expect(existsSync(oldPath)).toBe(false);
    expect(await store.frameById(newId)).not.toBeNull();
  });

  it("keeps frame metadata when a retained file cannot be removed", async () => {
    const now = Date.now();
    const firstId = await insertFrame(now - 21 * 24 * 60 * 60_000);
    const blockedId = await insertFrame(now - 20 * 24 * 60 * 60_000);
    const blockedPath = expectDefined(await store.frameById(blockedId), "blocked frame").path;
    rmSync(blockedPath);
    mkdirSync(blockedPath);

    await expect(store.pruneFrames(now - 14 * 24 * 60 * 60_000)).rejects.toThrow();
    expect(await store.frameById(firstId)).not.toBeNull();
    expect(await store.frameById(blockedId)).not.toBeNull();

    rmSync(blockedPath, { recursive: true });
    expect(await store.pruneFrames(now - 14 * 24 * 60 * 60_000)).toBe(2);
    expect(await store.frameById(firstId)).toBeNull();
    expect(await store.frameById(blockedId)).toBeNull();
  });

  it("detaches pruned keyframes from surviving cards", async () => {
    const now = Date.now();
    const oldId = await insertFrame(now - 20 * 24 * 60 * 60_000);
    await store.replaceCardsInWindow(DAY, 0, Number.MAX_SAFE_INTEGER, [
      draft({ keyframeId: oldId }),
    ]);
    await store.pruneFrames(now - 14 * 24 * 60 * 60_000);
    expect((await store.cardsForDay(DAY))[0]?.keyframeId).toBeUndefined();
  });

  it("replaces observations on batch retry instead of appending", async () => {
    const t0 = Date.now();
    const frameId = await insertFrame(t0);
    const batchId = await store.createBatch({
      day: DAY,
      startMs: t0,
      endMs: t0 + 1000,
      frameIds: [frameId],
    });
    await store.replaceObservations(batchId, DAY, [
      { startMs: t0, endMs: t0 + 500, text: "first run" },
    ]);
    await store.replaceObservations(batchId, DAY, [
      { startMs: t0, endMs: t0 + 500, text: "retry run" },
    ]);
    const observations = await store.observationsInRange(DAY, 0, Number.MAX_SAFE_INTEGER);
    expect(observations).toHaveLength(1);
    expect(expectDefined(observations[0], "retried observation").text).toBe("retry run");
  });

  it("rejects observations for a missing batch", async () => {
    await expect(
      store.replaceObservations(999_999, DAY, [
        { startMs: 1, endMs: 2, text: "orphan observation" },
      ]),
    ).rejects.toThrow();
    expect(await store.observationsInRange(DAY, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("rolls back a card replacement with a missing keyframe", async () => {
    const base = new Date(`${DAY}T10:00:00`).getTime();
    await store.replaceCardsInWindow(DAY, base, base + 60_000, [draft({ title: "kept" })]);

    await expect(
      store.replaceCardsInWindow(DAY, base, base + 60_000, [
        draft({ title: "invalid", keyframeId: 999_999 }),
      ]),
    ).rejects.toThrow();
    expect((await store.cardsForDay(DAY)).map((card) => card.title)).toEqual(["kept"]);
  });

  it.each([false, true])(
    "selects current keyframes after pruning instead of retaining a stale draft id (survivor=%s)",
    async (survivor) => {
      const startMs = new Date(`${DAY}T10:00:00`).getTime();
      const expiredId = await insertFrame(startMs + 10 * 60_000);
      const remainingId = survivor ? await insertFrame(startMs + 25 * 60_000) : undefined;
      expect(await store.pruneFrames(startMs + 20 * 60_000)).toBe(1);
      await store.replaceCardsInWindow(
        DAY,
        startMs,
        startMs + 30 * 60_000,
        [draft({ keyframeId: expiredId })],
        { selectKeyframes: true },
      );
      const cards = await store.cardsForDay(DAY);
      expect(cards).toHaveLength(1);
      expect(cards[0]?.keyframeId).toBe(remainingId);
    },
  );

  it("requeues errored batches for explicit retry", async () => {
    const t0 = Date.now();
    const frameId = await insertFrame(t0);
    const batchId = await store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 1000,
      frameIds: [frameId],
    });
    await store.setBatchStatus(batchId, "error", "boom");
    expect(await store.nextPendingBatch()).toBeNull();
    expect(await store.resetErrorBatches()).toBe(1);
    const requeued = await store.nextPendingBatch();
    expect(requeued?.id).toBe(batchId);
    expect(requeued?.error).toBeUndefined();
  });

  it("keeps capture data owner-only on disk", () => {
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    expect(mode(store.framesDir)).toBe(0o700);
    expect(mode(path.join(dir, "logbook.sqlite"))).toBe(0o600);
  });

  it("stores and updates standups", async () => {
    await store.saveStandup(DAY, "## Done\n- shipped");
    await store.saveStandup(DAY, "## Done\n- shipped more");
    expect((await store.getStandup(DAY))?.text).toContain("shipped more");
  });

  it("migrates legacy tables to STRICT without losing batch assignments", async () => {
    await store.close();
    const databasePath = path.join(dir, "logbook.sqlite");
    rmSync(databasePath, { force: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        frame_count INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        captured_at_ms INTEGER NOT NULL,
        day TEXT NOT NULL,
        path TEXT NOT NULL,
        screen_index INTEGER NOT NULL DEFAULT 0,
        width INTEGER,
        height INTEGER,
        byte_size INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        idle INTEGER NOT NULL DEFAULT 0,
        batch_id INTEGER
      );
      INSERT INTO batches VALUES (7, '${DAY}', 10, 20, 'pending', NULL, 1, NULL, 10, 10);
      INSERT INTO frames VALUES (11, 10, '${DAY}', '/tmp/frame.jpg', 0, NULL, NULL, 1, 'hash', 0, 7);
    `);
    legacy.close();

    store = await LogbookStore.open(dir, workerModuleUrl);

    expect((await store.batchFrames(7)).map((frame) => frame.id)).toEqual([11]);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        migrated
          .prepare(
            `SELECT name, strict FROM pragma_table_list
             WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "batches", strict: 1 },
        { name: "cards", strict: 1 },
        { name: "frames", strict: 1 },
        { name: "observations", strict: 1 },
        { name: "standups", strict: 1 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it("refuses a newer schema without changing its stored data", async () => {
    await store.saveStandup(DAY, "Preserved future-version fixture");
    await store.close();
    const databasePath = path.join(dir, "logbook.sqlite");
    const future = new DatabaseSync(databasePath);
    future.exec("PRAGMA user_version = 2");
    future.close();

    await expect(LogbookStore.open(dir, workerModuleUrl)).rejects.toThrow(
      "Logbook database uses newer schema version 2; this build supports 1",
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(preserved.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(preserved.prepare("SELECT day, text FROM standups").all()).toEqual([
        { day: DAY, text: "Preserved future-version fixture" },
      ]);
    } finally {
      preserved.close();
    }
  });

  it("rolls back a legacy STRICT migration when stored data has the wrong type", async () => {
    const legacyDir = path.join(dir, "invalid-legacy");
    mkdirSync(legacyDir);
    const databasePath = path.join(legacyDir, "logbook.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE standups (day TEXT PRIMARY KEY, text TEXT NOT NULL, updated_ms TEXT NOT NULL);
      INSERT INTO standups VALUES ('${DAY}', 'legacy', 'not-an-integer');
    `);
    legacy.close();

    await expect(LogbookStore.open(legacyDir, workerModuleUrl)).rejects.toThrow(
      "Failed migrating SQLite table standups to STRICT",
    );

    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        preserved.prepare("SELECT strict FROM pragma_table_list WHERE name = 'standups'").get(),
      ).toEqual({ strict: 0 });
      expect(preserved.prepare("SELECT * FROM standups").get()).toEqual({
        day: DAY,
        text: "legacy",
        updated_ms: "not-an-integer",
      });
    } finally {
      preserved.close();
    }
  });
});
