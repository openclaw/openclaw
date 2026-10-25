import * as fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import { dayKeyFor } from "./day.js";
import { LogbookStore } from "./store.js";
import {
  BASE,
  DAY,
  batchInput,
  cardDraft,
  execSql,
  readRows,
  useLogbookFixture,
  withDatabase,
  workerModuleUrl,
} from "./test-fixtures.test-support.js";
import type { LogbookCardDraft } from "./types.js";

const fixture = useLogbookFixture("logbook-store-");
const draft = (overrides: Partial<LogbookCardDraft> = {}) =>
  cardDraft({ appPrimary: "github.com", ...overrides });

describe("LogbookStore", () => {
  let dir: string;
  let store: LogbookStore;

  beforeEach(async () => {
    dir = fixture.makeDir();
    store = await fixture.open(dir);
  });

  const createBatch = (ids: number[], start: number, end = start + 1000, day = dayKeyFor(start)) =>
    store.createBatch(batchInput(ids, start, end, day));
  const replaceCards = (drafts: LogbookCardDraft[]) =>
    store.replaceCardsInWindow(DAY, BASE, BASE + 60_000, drafts);
  const cardTitles = async () => (await store.cardsForDay(DAY)).map(({ title }) => title);
  const insertFrame = async (capturedAtMs: number) => {
    const day = dayKeyFor(capturedAtMs);
    return await store.captureFrame({
      capturedAtMs,
      day,
      screenIndex: 0,
      buffer: Buffer.from(`jpeg-bytes-${capturedAtMs}`),
    });
  };

  it("refuses a hardlinked database with another frame root before bootstrapping that root", async () => {
    const capturedAtMs = Date.now();
    const frameId = await insertFrame(capturedAtMs);
    const otherRoot = path.join(dir, "another-root");
    fs.mkdirSync(otherRoot);
    fs.linkSync(path.join(dir, "logbook.sqlite"), path.join(otherRoot, "logbook.sqlite"));
    await expect(fixture.open(otherRoot)).rejects.toThrow(
      "SQLite database already belongs to another worker backend",
    );
    expect(fs.existsSync(path.join(otherRoot, "frames"))).toBe(false);
    expect(await store.framesInRange(capturedAtMs, capturedAtMs + 1)).toMatchObject([
      {
        id: frameId,
        capturedAtMs,
      },
    ]);
    expect(await store.framePayload(frameId)).toMatchObject({
      frameId,
      capturedAtMs,
      base64: Buffer.from(`jpeg-bytes-${capturedAtMs}`).toString("base64"),
    });
    expect(
      fs.readFileSync(store.frameFilePath(dayKeyFor(capturedAtMs), capturedAtMs), "utf8"),
    ).toBe(`jpeg-bytes-${capturedAtMs}`);
    expect(await store.countUnbatchedActiveFrames()).toBe(1);
  });

  it("rolls back large frame claims with a late missing or duplicate frame", async () => {
    const t0 = Date.now();
    const frameIds = await Promise.all(
      Array.from({ length: 70 }, (_, index) => insertFrame(t0 + index)),
    );
    const firstFrameId = expectDefined(frameIds[0], "first frame");

    for (const invalidFrameId of [999_999, firstFrameId]) {
      await expect(createBatch([...frameIds, invalidFrameId], t0)).rejects.toThrow(
        `Logbook frame ${invalidFrameId} is missing or already batched`,
      );

      expect(await store.latestBatch()).toBeNull();
      expect((await store.unbatchedActiveFrames(100)).map((frame) => frame.id)).toEqual(frameIds);
    }

    const batchId = await createBatch(frameIds, t0);
    expect(await store.latestBatch()).toMatchObject({ id: batchId, frameCount: 70 });
    expect(await store.countUnbatchedActiveFrames()).toBe(0);
  });

  it("does not steal a frame from an existing batch", async () => {
    const t0 = Date.now();
    const firstFrame = await insertFrame(t0);
    const secondFrame = await insertFrame(t0 + 1000);
    const firstBatch = await createBatch([firstFrame], t0);

    await expect(createBatch([firstFrame, secondFrame], t0, t0 + 2000)).rejects.toThrow(
      `Logbook frame ${firstFrame} is missing or already batched`,
    );

    expect((await store.latestBatch())?.id).toBe(firstBatch);
    expect((await store.batchImages(firstBatch)).map(({ frame }) => frame.id)).toEqual([
      firstFrame,
    ]);
    expect((await store.unbatchedActiveFrames(10)).map((frame) => frame.id)).toEqual([secondFrame]);
  });

  it("rejects empty and duplicate frame claims without leaving a batch", async () => {
    const t0 = Date.now();
    await expect(createBatch([], t0, t0 + 1000, DAY)).rejects.toThrow(
      "Logbook batch requires at least one frame",
    );
    const frameId = await insertFrame(t0);
    await expect(createBatch([frameId, frameId], t0, t0 + 1000, DAY)).rejects.toThrow(
      `Logbook frame ${frameId} is missing or already batched`,
    );
    expect(await store.latestBatch()).toBeNull();
    expect(await store.countUnbatchedActiveFrames()).toBe(1);
  });

  it("round-trips distractions and computes day stats", async () => {
    const distractions = [
      { startMs: BASE + 5 * 60_000, endMs: BASE + 10 * 60_000, title: "Twitter" },
    ];
    await store.replaceCardsInWindow(DAY, BASE, BASE + 60 * 60_000, [
      draft({ distractions }),
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
    expect(expectDefined(cards[0], "stored logbook card").distractions).toEqual(distractions);
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
    withDatabase(path.join(dir, "logbook.sqlite"), (database) => {
      database.prepare("UPDATE cards SET distractions = ? WHERE title = ?").run("{", "Review");
    });
    await expect(store.cardsForDay(DAY)).rejects.toThrow(/JSON/);
    await expect(store.timelineForDay(DAY)).rejects.toThrow(/JSON/);
  });

  it("keeps frame metadata when a retained file cannot be removed", async () => {
    const now = Date.now();
    const firstId = await insertFrame(now - 21 * 24 * 60 * 60_000);
    const blockedId = await insertFrame(now - 20 * 24 * 60 * 60_000);
    const blockedPath = store.frameFilePath(
      dayKeyFor(now - 20 * 24 * 60 * 60_000),
      now - 20 * 24 * 60 * 60_000,
    );
    fs.rmSync(blockedPath);
    fs.mkdirSync(blockedPath);

    await expect(store.pruneFrames(now - 14 * 24 * 60 * 60_000)).rejects.toThrow();
    expect(
      (await store.framesInRange(now - 21 * 24 * 60 * 60_000, now)).map((frame) => frame.id),
    ).toEqual([firstId, blockedId]);

    fs.rmSync(blockedPath, { recursive: true });
    expect(await store.pruneFrames(now - 14 * 24 * 60 * 60_000)).toBe(2);
    expect(await store.framesInRange(now - 21 * 24 * 60 * 60_000, now)).toEqual([]);
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
    const batchId = await createBatch([frameId], 1, 2, DAY);
    const segments = Array.from({ length: 70 }, (_, index) => ({
      startMs: 1,
      endMs: 2,
      text: `Observation ${Math.max(0, index - 1)}`,
    }));
    await store.replaceObservations(batchId, DAY, [{ startMs: 1, endMs: 2, text: "replaced" }]);
    await store.replaceObservations(batchId, DAY, segments);
    expect(await store.observationsInRange(DAY, 0, 3)).toMatchObject(segments);

    await expect(
      store.replaceObservations(batchId, DAY, [
        ...segments,
        { startMs: 1.5, endMs: 2, text: "invalid integer timestamp" },
      ]),
    ).rejects.toThrow();
    expect(await store.observationsInRange(DAY, 0, 3)).toMatchObject(segments);

    await store.replaceObservations(batchId, DAY, []);
    expect(await store.observationsInRange(DAY, 0, 3)).toEqual([]);
  });

  it("replaces large card sets in order and rolls back a late invalid timestamp", async () => {
    const drafts = Array.from({ length: 70 }, (_, index) => draft({ title: `Card ${index}` }));
    const titles = drafts.map(({ title }) => title);
    await replaceCards([draft({ title: "replaced" })]);
    await replaceCards(drafts);
    expect(await cardTitles()).toEqual(titles);

    await expect(
      replaceCards([...drafts, draft({ title: "invalid", startMs: BASE + 0.5 })]),
    ).rejects.toThrow(/INTEGER column cards\.start_ms/);
    expect(await cardTitles()).toEqual(titles);

    await replaceCards([]);
    expect(await store.cardsForDay(DAY)).toEqual([]);
  });

  it("keeps capture data owner-only on disk", () => {
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    expect(mode(store.framesDir)).toBe(0o700);
    expect(mode(path.join(dir, "logbook.sqlite"))).toBe(0o600);
  });

  it("migrates legacy tables to STRICT without losing batch assignments", async () => {
    await store.close();
    const databasePath = path.join(dir, "logbook.sqlite");
    fs.rmSync(databasePath, { force: true });
    execSql(
      databasePath,
      `
      CREATE TABLE batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL,
        start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT,
        frame_count INTEGER NOT NULL DEFAULT 0, model TEXT,
        created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL
      );
      CREATE TABLE frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT, captured_at_ms INTEGER NOT NULL,
        day TEXT NOT NULL, path TEXT NOT NULL, screen_index INTEGER NOT NULL DEFAULT 0,
        width INTEGER, height INTEGER, byte_size INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL, idle INTEGER NOT NULL DEFAULT 0, batch_id INTEGER
      );
      INSERT INTO batches VALUES (7, '${DAY}', 10, 20, 'pending', NULL, 1, NULL, 10, 10);
      INSERT INTO frames VALUES (11, 10, '${DAY}', '/tmp/frame.jpg', 0, NULL, NULL, 1, 'hash', 0, 7);
    `,
    );

    store = await fixture.open(dir);

    expect(readRows(databasePath, "SELECT id, batch_id FROM frames")).toEqual([
      { id: 11, batch_id: 7 },
    ]);
    expect(
      readRows(
        databasePath,
        `SELECT name, strict FROM pragma_table_list
             WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name`,
      ),
    ).toEqual(
      ["batches", "cards", "frames", "observations", "standups"].map((name) => ({
        name,
        strict: 1,
      })),
    );
  });

  it("refuses a newer schema without changing its stored data", async () => {
    await store.saveStandup(DAY, "Preserved future-version fixture");
    await store.close();
    const databasePath = path.join(dir, "logbook.sqlite");
    // The future-version file must reach its first managed admission here.
    fs.renameSync(databasePath, `${databasePath}.seed`);
    fs.copyFileSync(`${databasePath}.seed`, databasePath);
    execSql(databasePath, "PRAGMA user_version = 3");

    await expect(LogbookStore.open(dir, workerModuleUrl)).rejects.toThrow(
      "Logbook database uses newer schema version 3; this build supports 2",
    );
    expect(readRows(databasePath, "PRAGMA user_version")).toEqual([{ user_version: 3 }]);
    expect(readRows(databasePath, "SELECT day, text FROM standups")).toEqual([
      { day: DAY, text: "Preserved future-version fixture" },
    ]);
  });

  it("rolls back a legacy STRICT migration when stored data has the wrong type", async () => {
    const legacyDir = path.join(dir, "invalid-legacy");
    fs.mkdirSync(legacyDir);
    const databasePath = path.join(legacyDir, "logbook.sqlite");
    execSql(
      databasePath,
      `
      CREATE TABLE standups (day TEXT PRIMARY KEY, text TEXT NOT NULL, updated_ms TEXT NOT NULL);
      INSERT INTO standups VALUES ('${DAY}', 'legacy', 'not-an-integer');
    `,
    );

    await expect(LogbookStore.open(legacyDir, workerModuleUrl)).rejects.toThrow(
      "Failed migrating SQLite table standups to STRICT",
    );

    expect(
      readRows(databasePath, "SELECT strict FROM pragma_table_list WHERE name = 'standups'"),
    ).toEqual([{ strict: 0 }]);
    expect(readRows(databasePath, "SELECT * FROM standups")).toEqual([
      { day: DAY, text: "legacy", updated_ms: "not-an-integer" },
    ]);
  });
});
