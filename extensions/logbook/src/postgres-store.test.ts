import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import {
  openEngineStore,
  withEngineStoreAdmission,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { logbookEngineSchema } from "./store-engine-schema.js";
import { createLogbookDatabase } from "./store-schema-admission.js";
import { createSqliteWorkerBackend } from "./store.worker.js";
import { frameInput } from "./test-fixtures.test-support.js";
import type { LogbookCardDraft } from "./types.js";

// mock-isolation: Exercise the real SQL owner in-process; broker transport is covered separately.
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-worker-runtime")>();
  return { ...actual, requestSqliteWorkerOperationAdmission: vi.fn() };
});

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const DAY = "2026-07-03";
const window = { day: DAY, startMs: 0, endMs: 10_000 };

describe.skipIf(!connection)("PostgreSQL logbook operations", () => {
  let backend: ReturnType<typeof createSqliteWorkerBackend>;
  let dataDir: string;
  let databasePath: string;
  let namespace: string;
  let observer: Client;
  const open = () =>
    withEngineStoreAdmission(() =>
      createSqliteWorkerBackend(
        { dataDir, postgresInput: { connection: connection!, schemaPrefix: "logbook_test" } },
        { databasePath },
      ),
    );
  const execute: typeof backend.execute = (command) =>
    withEngineStoreAdmission(() => backend.execute(command));
  const saveStandup = (text: string, day = DAY) =>
    execute({ type: "saveStandup", input: { day, text } });
  const observations = (tailLimit?: number) =>
    execute({ type: "observationsInRange", input: { ...window, tailLimit } });
  const replace = (drafts: LogbookCardDraft[], span = window) =>
    execute({ type: "replaceCardsInWindow", input: { ...span, drafts } });
  const query = async (schema: string, sql: string) =>
    (await observer.query<Record<string, unknown>>(sql.replaceAll("$schema", `"${schema}"`))).rows;
  const upgrade = async (pathname: string, input: Parameters<typeof createLogbookDatabase>[1]) =>
    withEngineStoreAdmission(() => createLogbookDatabase(pathname, input)).close();

  function legacyStore(version: number, seed: (db: EngineConnection) => void) {
    const pathname = path.join(tempDirs.make("logbook-index-upgrade-"), "logbook.sqlite");
    const input = { connection: connection!, schemaPrefix: "logbook_upgrade" };
    const migration = logbookEngineSchema.postgresMigrations!.find(
      (step) => step.version === version + 1,
    )!;
    const schema = withEngineStoreAdmission(() => {
      using anchor = new DatabaseSync(pathname);
      const db = openEngineStore({
        anchor,
        input,
        schema: {
          ...logbookEngineSchema,
          ...migration.fromSchema,
          version,
          postgresMigrations: version === 1 ? logbookEngineSchema.postgresMigrations : [],
        },
        prepareAnchor: () => {},
        inspectSqlite: () => ({ hasEngineAnchor: false, hasExistingData: false }),
        openSqlite: () => {},
      });
      try {
        seed(db);
        return String(anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema);
      } finally {
        db.close();
      }
    });
    return { pathname, input, schema };
  }

  beforeAll(async () => {
    dataDir = tempDirs.make("logbook-postgres-");
    databasePath = path.join(dataDir, "logbook.sqlite");
    observer = new Client({ connectionString: connection });
    await observer.connect();
    backend = open();
    using anchor = new DatabaseSync(databasePath, { readOnly: true });
    const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
    assert(typeof row?.schema === "string");
    namespace = row.schema;
  });

  afterAll(async () => {
    try {
      await backend?.close();
      if (namespace) {
        await observer.query(`DROP SCHEMA "${namespace}" CASCADE`);
      }
    } finally {
      await observer?.end();
    }
  });

  it.each([1, 2])("upgrades v%i indexes once without losing stored data", async (version) => {
    const { pathname, input, schema } = legacyStore(version, (db) => {
      db.prepare("INSERT INTO standups VALUES (?, ?, ?)").run(DAY, "Retained standup", 1);
      db.prepare(
        "INSERT INTO batches (id, day, start_ms, end_ms, created_ms, updated_ms) VALUES (1, ?, 0, 1000, 1, 1)",
      ).run(DAY);
      db.prepare(
        `INSERT INTO frames (id, captured_at_ms, day, path, content_hash, batch_id)
           VALUES (1, 100, ?, 'retained.jpg', 'retained-hash', 1),
             (2, 200, ?, 'unbatched.jpg', 'unbatched-hash', NULL)`,
      ).run(DAY, DAY);
      db.prepare(
        `INSERT INTO cards (id, day, start_ms, end_ms, title, summary, keyframe_id, updated_ms)
           VALUES (1, ?, 0, 1000, 'Retained', 'Retained summary', 1, 1),
             (2, ?, 1000, 2000, 'No keyframe', 'Nullable summary', NULL, 1)`,
      ).run(DAY, DAY);
    });
    const indexes = async () =>
      (
        await observer.query<{ name: string; oid: string; options: string }>(
          `SELECT c.relname AS name, c.oid::text AS oid, i.indoption::text AS options
           FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
           WHERE c.relnamespace = $1::regnamespace ORDER BY c.relname`,
          [schema],
        )
      ).rows;
    const changedNames = ["idx_logbook_cards_keyframe", "idx_logbook_frames_batch"];
    try {
      const before = await indexes();
      const named = (rows: Awaited<ReturnType<typeof indexes>>, name: string) =>
        rows.find((index) => index.name === name)!;
      const partial = (rows: Awaited<ReturnType<typeof indexes>>) =>
        rows.filter((index) => changedNames.includes(index.name));
      if (version === 2) {
        expect(named(before, "idx_logbook_frames_captured_at").options).toBe("0");
        expect(partial(before).map((index) => index.options)).toEqual(["2", "2 0"]);
      }
      await upgrade(pathname, input);
      const after = await indexes();
      if (version === 1) {
        const captured = named(after, "idx_logbook_frames_captured_at");
        expect(captured.options).toBe("0");
        expect(captured.oid).not.toBe(named(before, captured.name).oid);
        expect(named(after, "idx_logbook_frames_unbatched")).toEqual(
          named(before, "idx_logbook_frames_unbatched"),
        );
      } else {
        expect(
          after
            .filter((index) => index.oid !== named(before, index.name).oid)
            .map((index) => index.name),
        ).toEqual(changedNames);
        expect(partial(after).map((index) => index.options)).toEqual(["0", "0 0"]);
        expect(after.filter((index) => !changedNames.includes(index.name))).toEqual(
          before.filter((index) => !changedNames.includes(index.name)),
        );
      }
      expect(await query(schema, "SELECT text FROM $schema.standups")).toEqual([
        { text: "Retained standup" },
      ]);
      expect(
        await query(schema, "SELECT path, batch_id::integer FROM $schema.frames ORDER BY id"),
      ).toEqual([
        { path: "retained.jpg", batch_id: 1 },
        { path: "unbatched.jpg", batch_id: null },
      ]);
      expect(
        await query(
          schema,
          "SELECT title, summary, keyframe_id::integer FROM $schema.cards ORDER BY id",
        ),
      ).toEqual([
        { title: "Retained", summary: "Retained summary", keyframe_id: 1 },
        { title: "No keyframe", summary: "Nullable summary", keyframe_id: null },
      ]);
      expect(
        await query(schema, "SELECT version::integer FROM $schema.openclaw_schema_meta"),
      ).toEqual([{ version: 3 }]);
      await upgrade(pathname, input);
      expect(await indexes()).toEqual(after);
    } finally {
      await observer.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  function frame(capturedAtMs: number, idle = false, day = DAY): number {
    const file = path.join(dataDir, "frames", day, `${capturedAtMs}-${idle}.jpg`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "synthetic-jpeg");
    const result = execute({
      type: "insertFrame",
      input: frameInput({
        capturedAtMs,
        day,
        path: file,
        byteSize: 14,
        contentHash: `synthetic-${capturedAtMs}-${idle}`,
        idle,
      }),
    });
    assert(typeof result === "number");
    return result;
  }

  function batch(frameIds: number[], day = DAY): number {
    const result = execute({
      type: "createBatch",
      input: { day, startMs: 0, endMs: 100_000, frameIds },
    });
    assert(typeof result === "number");
    return result;
  }

  const card = (overrides: Partial<LogbookCardDraft> = {}): LogbookCardDraft => ({
    ...window,
    title: "Coding",
    summary: "Synthetic summary",
    detail: "Synthetic detail",
    category: "coding",
    appPrimary: "example.test",
    distractions: [{ startMs: 1000, endMs: 2000, title: "Break" }],
    ...overrides,
  });

  it("returns identities, rolls back failed claims, and truncates sampling with timestamp ties", () => {
    const ids = Array.from({ length: 18 }, (_, index) => frame(Math.floor(index / 2) * 1000));
    expect(ids).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    const idle = frame(9000, true);
    expect(execute({ type: "countUnbatchedActiveFrames", input: undefined })).toBe(18);
    expect(execute({ type: "unbatchedActiveFrames", input: { limit: 2 } })).toEqual([
      { id: 1, capturedAtMs: 0 },
      { id: 2, capturedAtMs: 0 },
    ]);
    expect(() => batch([])).toThrow("requires at least one frame");
    expect(() => batch([1, 999_999])).toThrow("999999 is missing or already batched");
    expect(() => batch([1, 1])).toThrow("1 is missing or already batched");
    expect(execute({ type: "latestBatch", input: undefined })).toBeNull();
    expect(execute({ type: "countUnbatchedActiveFrames", input: undefined })).toBe(18);
    const batchId = batch(ids);
    expect(execute({ type: "sampledBatchFrames", input: { batchId } })).toEqual(
      [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18].map((id) =>
        expect.objectContaining({ id }),
      ),
    );
    expect(() => batch([1, idle])).toThrow("1 is missing or already batched");
    expect(execute({ type: "frameById", input: { id: idle } })).toMatchObject({ idle: true });
    expect(execute({ type: "countUnbatchedActiveFrames", input: undefined })).toBe(0);
    execute({ type: "setBatchStatus", input: { batchId, status: "running", model: "test" } });
    execute({ type: "resetRunningBatches", input: undefined });
    expect(execute({ type: "nextPendingBatch", input: undefined })).toMatchObject({
      id: batchId,
      status: "pending",
      model: "test",
    });
    execute({ type: "setBatchStatus", input: { batchId, status: "error", error: "retry" } });
    expect(execute({ type: "resetErrorBatches", input: undefined })).toBe(1);
    expect(execute({ type: "resetErrorBatches", input: undefined })).toBe(0);
  });

  it("replaces observations, cards, and standups without duplicate or partial results", () => {
    const batchId = batch([frame(20_000)]);
    const observe = (...texts: string[]) =>
      execute({
        type: "replaceObservations",
        input: {
          batchId,
          day: DAY,
          segments: texts.map((text) => ({ startMs: 0, endMs: 10_000, text })),
        },
      });
    observe("old");
    observe("first", "second");
    expect(observations()).toEqual([
      expect.objectContaining({ batchId, text: "first" }),
      expect.objectContaining({ batchId, text: "second" }),
    ]);
    expect(observations(1)).toEqual([expect.objectContaining({ text: "second" })]);
    replace([card({ title: "Old" })]);
    replace([card()]);
    expect(() => replace([card({ title: "Invalid", startMs: 0.5 })])).toThrow();
    expect(execute({ type: "countCardsForDay", input: { day: DAY } })).toBe(1);
    expect(execute({ type: "cardsForDay", input: { day: DAY } })).toEqual([
      expect.objectContaining({ title: "Coding", distractions: card().distractions }),
    ]);
    expect(execute({ type: "timelineForDay", input: { day: DAY } })).toMatchObject({
      stats: {
        trackedMs: 10_000,
        distractionMs: 1000,
        categories: [{ category: "coding", ms: 10_000 }],
        apps: [{ domain: "example.test", ms: 10_000 }],
      },
    });
    saveStandup("Old");
    saveStandup("Retained");
    expect(execute({ type: "getStandup", input: { day: DAY } })).toMatchObject({
      text: "Retained",
    });
  });

  it("prunes file artifacts and foreign keys, then reopens the same PostgreSQL store", async () => {
    const day = "2026-07-04";
    const id = frame(-1000, false, day);
    const file = path.join(dataDir, "frames", day, "-1000-false.jpg");
    const span = { day, startMs: -1000, endMs: 0 };
    replace([card(span)], span);
    expect(execute({ type: "pruneFrames", input: { olderThanMs: 0 } })).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(execute({ type: "frameById", input: { id } })).toBeNull();
    expect(execute({ type: "cardsForDay", input: { day } })).toEqual([
      expect.objectContaining({ keyframeId: undefined, title: "Coding" }),
    ]);
    saveStandup("After pruning", day);
    await backend.close();
    backend = open();
    expect(execute({ type: "getStandup", input: { day } })).toMatchObject({
      text: "After pruning",
    });
    using anchor = new DatabaseSync(databasePath, { readOnly: true });
    expect(anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()).toEqual({
      schema: namespace,
    });
    expect(
      anchor.prepare("SELECT name FROM sqlite_schema WHERE name = 'frames'").get(),
    ).toBeUndefined();
  });
});
