import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dayKeyFor } from "./day.js";
import { logbookSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { LogbookStore } from "./store.js";
import type { LogbookCardDraft } from "./types.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint);
const DAY = "2026-07-03";

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

  it("rolls back large frame claims with a late missing or duplicate frame", async () => {
    const t0 = Date.now();
    const frameIds = await Promise.all(
      Array.from({ length: 70 }, (_, index) => insertFrame(t0 + index)),
    );
    const firstFrameId = expectDefined(frameIds[0], "first frame");

    for (const invalidFrameId of [999_999, firstFrameId]) {
      await expect(
        store.createBatch({
          day: dayKeyFor(t0),
          startMs: t0,
          endMs: t0 + 1000,
          frameIds: [...frameIds, invalidFrameId],
        }),
      ).rejects.toThrow(`Logbook frame ${invalidFrameId} is missing or already batched`);

      expect(await store.latestBatch()).toBeNull();
      expect((await store.unbatchedActiveFrames(100)).map((frame) => frame.id)).toEqual(frameIds);
    }

    const batchId = await store.createBatch({
      day: dayKeyFor(t0),
      startMs: t0,
      endMs: t0 + 1000,
      frameIds,
    });
    expect(await store.latestBatch()).toMatchObject({ id: batchId, frameCount: 70 });
    expect(await store.countUnbatchedActiveFrames()).toBe(0);
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
    expect((await store.batchImages(firstBatch)).map(({ frame }) => frame.id)).toEqual([
      firstFrame,
    ]);
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

  it("round-trips distractions and computes day stats", async () => {
    const base = new Date(`${DAY}T10:00:00`).getTime();
    await store.replaceCardsInWindow(DAY, base, base + 60 * 60_000, [
      draft({
        distractions: [{ startMs: base + 5 * 60_000, endMs: base + 10 * 60_000, title: "Twitter" }],
      }),
      draft({ title: "Review", category: "review", appPrimary: undefined, appSecondary: "" }),
    ]);
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
    const database = new DatabaseSync(path.join(dir, "logbook.sqlite"));
    try {
      database.prepare("UPDATE cards SET distractions = ? WHERE title = ?").run("{", "Review");
    } finally {
      database.close();
    }
    await expect(store.cardsForDay(DAY)).rejects.toThrow(/JSON/);
    await expect(store.timelineForDay(DAY)).rejects.toThrow(/JSON/);
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

  it("rejects observations for a missing batch", async () => {
    await expect(
      store.replaceObservations(999_999, DAY, [
        { startMs: 1, endMs: 2, text: "orphan observation" },
      ]),
    ).rejects.toThrow();
    expect(await store.observationsInRange(DAY, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("replaces large observation sets in order and rolls back a late invalid timestamp", async () => {
    const frameId = await insertFrame(Date.now());
    const batchId = await store.createBatch({
      day: DAY,
      startMs: 1,
      endMs: 2,
      frameIds: [frameId],
    });
    const segments = Array.from({ length: 70 }, (_, index) => ({
      startMs: 1,
      endMs: 2,
      text: `Observation ${Math.max(0, index - 1)}`,
    }));
    await store.replaceObservations(batchId, DAY, [{ startMs: 1, endMs: 2, text: "replaced" }]);
    await store.replaceObservations(batchId, DAY, segments);
    expect(
      (await store.observationsInRange(DAY, 0, 3)).map(({ startMs, endMs, text }) => ({
        startMs,
        endMs,
        text,
      })),
    ).toEqual(segments);

    await expect(
      store.replaceObservations(batchId, DAY, [
        ...segments,
        { startMs: 1.5, endMs: 2, text: "invalid integer timestamp" },
      ]),
    ).rejects.toThrow();
    expect((await store.observationsInRange(DAY, 0, 3)).map(({ text }) => text)).toEqual(
      segments.map(({ text }) => text),
    );

    await store.replaceObservations(batchId, DAY, []);
    expect(await store.observationsInRange(DAY, 0, 3)).toEqual([]);
  });

  it("replaces large card sets in order and rolls back a late missing keyframe", async () => {
    const base = new Date(`${DAY}T10:00:00`).getTime();
    const drafts = Array.from({ length: 70 }, (_, index) => draft({ title: `Card ${index}` }));
    await store.replaceCardsInWindow(DAY, base, base + 60_000, [draft({ title: "replaced" })]);
    await store.replaceCardsInWindow(DAY, base, base + 60_000, drafts);
    expect((await store.cardsForDay(DAY)).map(({ title }) => title)).toEqual(
      drafts.map(({ title }) => title),
    );

    await expect(
      store.replaceCardsInWindow(DAY, base, base + 60_000, [
        ...drafts,
        draft({ title: "invalid", keyframeId: 999_999 }),
      ]),
    ).rejects.toThrow();
    expect((await store.cardsForDay(DAY)).map(({ title }) => title)).toEqual(
      drafts.map(({ title }) => title),
    );

    await store.replaceCardsInWindow(DAY, base, base + 60_000, []);
    expect(await store.cardsForDay(DAY)).toEqual([]);
  });

  it("keeps capture data owner-only on disk", () => {
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    expect(mode(store.framesDir)).toBe(0o700);
    expect(mode(path.join(dir, "logbook.sqlite"))).toBe(0o600);
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

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(migrated.prepare("SELECT id, batch_id FROM frames").all()).toEqual([
        { id: 11, batch_id: 7 },
      ]);
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
    // The future-version file must reach its first managed admission here.
    renameSync(databasePath, `${databasePath}.seed`);
    copyFileSync(`${databasePath}.seed`, databasePath);
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
