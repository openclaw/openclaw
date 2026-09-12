import { chmodSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  prepareSqliteQuerySync,
  runSqliteImmediateTransactionSync,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { pickKeyframeId } from "./analyze.js";
import type {
  LogbookBatchInput,
  LogbookDay,
  LogbookFrameInput,
  LogbookObservationInput,
  LogbookOperations,
  LogbookStandup,
  LogbookTimeline,
} from "./store-contract.js";
import {
  LOGBOOK_SCHEMA_VERSION,
  SCHEMA,
  toBatch,
  toCard,
  toFrame,
  type LogbookDatabase,
} from "./store-schema.js";
import type {
  LogbookBatch,
  LogbookBatchStatus,
  LogbookCard,
  LogbookCardDraft,
  LogbookFrame,
  LogbookObservation,
} from "./types.js";

type Database = import("node:sqlite").DatabaseSync;

const LOGBOOK_SQLITE_BUSY_TIMEOUT_MS = 5_000;
const FRAME_PRUNE_BATCH_SIZE = 64;
class LogbookDatabaseStore {
  private readonly db: Database;
  private readonly query;
  private readonly framesQuery;
  private readonly batchesQuery;
  private readonly cardsQuery;
  private readonly statements;
  private readonly walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas>;
  readonly framesDir: string;

  constructor(dataDir: string, dbPath: string) {
    // Screen captures and their database remain owner-only even in a permissive state directory.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.framesDir = path.join(dataDir, "frames");
    mkdirSync(this.framesDir, { recursive: true, mode: 0o700 });
    chmodSync(this.framesDir, 0o700);
    const db = openNodeSqliteDatabase(dbPath);
    let walMaintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
    try {
      enableNodeSqliteKyselyStatementCache(db);
      // WAL/SHM sidecars inherit the main DB file's permissions.
      chmodSync(dbPath, 0o600);
      walMaintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        databasePath: dbPath,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      const versionRow = db.prepare("PRAGMA user_version").get();
      const schemaVersion = Number(versionRow?.user_version ?? 0);
      if (schemaVersion > LOGBOOK_SCHEMA_VERSION) {
        throw new Error(
          `Logbook database uses newer schema version ${schemaVersion}; this build supports ${LOGBOOK_SCHEMA_VERSION}`,
        );
      }
      db.exec(SCHEMA);
      if (schemaVersion < LOGBOOK_SCHEMA_VERSION) {
        migrateSqliteSchemaToStrict(db, SCHEMA, { databaseLabel: dbPath });
        db.exec(`PRAGMA user_version = ${LOGBOOK_SCHEMA_VERSION};`);
      }
      this.db = db;
      this.walMaintenance = walMaintenance;
      this.query = getNodeSqliteKysely<LogbookDatabase>(db);
      // Timestamp ties follow insertion ids, matching existing SQLite reads.
      this.framesQuery = this.query
        .selectFrom("frames")
        .select([
          "id",
          "captured_at_ms",
          "day",
          "path",
          "screen_index",
          "width",
          "height",
          "byte_size",
          "idle",
        ])
        .orderBy("captured_at_ms", "asc")
        .orderBy("id", "asc");
      this.batchesQuery = this.query
        .selectFrom("batches")
        .select(["id", "day", "start_ms", "end_ms", "status", "error", "frame_count", "model"]);
      this.cardsQuery = this.query.selectFrom("cards");
      this.statements = {
        insertFrame: prepareSqliteQuerySync<LogbookFrameInput>(db, (p) =>
          this.query.insertInto("frames").values({
            captured_at_ms: p((row) => row.capturedAtMs),
            day: p((row) => row.day),
            path: p((row) => row.path),
            screen_index: p((row) => row.screenIndex),
            width: p((row) => row.width ?? null),
            height: p((row) => row.height ?? null),
            byte_size: p((row) => row.byteSize),
            content_hash: p((row) => row.contentHash),
            idle: p((row) => (row.idle ? 1 : 0)),
          }),
        ),
        insertBatch: prepareSqliteQuerySync<LogbookBatchInput & { now: number }>(db, (p) =>
          this.query.insertInto("batches").values({
            day: p((row) => row.day),
            start_ms: p((row) => row.startMs),
            end_ms: p((row) => row.endMs),
            status: "pending",
            frame_count: p((row) => row.frameIds.length),
            created_ms: p((row) => row.now),
            updated_ms: p((row) => row.now),
          }),
        ),
        assignFrame: prepareSqliteQuerySync<{ batchId: number; frameId: number }>(db, (p) =>
          this.query
            .updateTable("frames")
            .set({ batch_id: p((row) => row.batchId) })
            .where(
              "id",
              "=",
              p((row) => row.frameId),
            )
            .where("batch_id", "is", null),
        ),
        setBatchStatus: prepareSqliteQuerySync<
          LogbookOperations["setBatchStatus"]["input"] & { now: number }
        >(db, (p) =>
          this.query
            .updateTable("batches")
            .set((eb) => ({
              status: p((row) => row.status),
              error: p((row) => row.error ?? null),
              model: eb.fn.coalesce(
                p((row) => row.model ?? null),
                "model",
              ),
              updated_ms: p((row) => row.now),
            }))
            .where(
              "id",
              "=",
              p((row) => row.batchId),
            ),
        ),
        resetRunningBatches: prepareSqliteQuerySync<number>(db, (p) =>
          this.query
            .updateTable("batches")
            .set({ status: "pending", updated_ms: p((now) => now) })
            .where("status", "=", "running"),
        ),
        resetErrorBatches: prepareSqliteQuerySync<number>(db, (p) =>
          this.query
            .updateTable("batches")
            .set({ status: "pending", error: null, updated_ms: p((now) => now) })
            .where("status", "=", "error"),
        ),
        deleteObservations: prepareSqliteQuerySync<number>(db, (p) =>
          this.query.deleteFrom("observations").where(
            "batch_id",
            "=",
            p((batchId) => batchId),
          ),
        ),
        insertObservation: prepareSqliteQuerySync<
          LogbookObservationInput & { batchId: number; day: string }
        >(db, (p) =>
          this.query.insertInto("observations").values({
            batch_id: p((row) => row.batchId),
            day: p((row) => row.day),
            start_ms: p((row) => row.startMs),
            end_ms: p((row) => row.endMs),
            text: p((row) => row.text),
          }),
        ),
        deleteCards: prepareSqliteQuerySync<{ day: string; startMs: number; endMs: number }>(
          db,
          (p) =>
            this.query
              .deleteFrom("cards")
              .where(
                "day",
                "=",
                p((window) => window.day),
              )
              .where(
                "end_ms",
                ">",
                p((window) => window.startMs),
              )
              .where(
                "start_ms",
                "<",
                p((window) => window.endMs),
              ),
        ),
        insertCard: prepareSqliteQuerySync<LogbookCardDraft & { now: number }>(db, (p) =>
          this.query.insertInto("cards").values({
            day: p((row) => row.day),
            start_ms: p((row) => row.startMs),
            end_ms: p((row) => row.endMs),
            title: p((row) => row.title),
            summary: p((row) => row.summary),
            detail: p((row) => row.detail),
            category: p((row) => row.category),
            app_primary: p((row) => row.appPrimary ?? null),
            app_secondary: p((row) => row.appSecondary ?? null),
            distractions: p((row) => JSON.stringify(row.distractions)),
            keyframe_id: p((row) => row.keyframeId ?? null),
            updated_ms: p((row) => row.now),
          }),
        ),
        saveStandup: prepareSqliteQuerySync<{ day: string; text: string; now: number }>(db, (p) =>
          this.query
            .insertInto("standups")
            .values({
              day: p((row) => row.day),
              text: p((row) => row.text),
              updated_ms: p((row) => row.now),
            })
            .onConflict((conflict) =>
              conflict.column("day").doUpdateSet((eb) => ({
                text: eb.ref("excluded.text"),
                updated_ms: eb.ref("excluded.updated_ms"),
              })),
            ),
        ),
      };
    } catch (error) {
      // Preserve the opening failure while attempting both resource cleanups.
      try {
        walMaintenance?.close();
      } catch {}
      try {
        db.close();
      } catch {}
      throw error;
    }
  }

  close(): void {
    try {
      this.walMaintenance.close();
    } finally {
      this.db.close();
    }
  }

  insertFrame(params: LogbookFrameInput): number {
    const result = this.statements.insertFrame(params);
    return Number(expectDefined(result.insertId, "Logbook inserted frame ID"));
  }

  lastFrame(): { capturedAtMs: number; contentHash: string } | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("frames")
        .select(["captured_at_ms", "content_hash"])
        .orderBy("captured_at_ms", "desc")
        .orderBy("id", "desc")
        .limit(1),
    );
    return row ? { capturedAtMs: row.captured_at_ms, contentHash: row.content_hash } : null;
  }

  unbatchedActiveFrames(limit: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("batch_id", "is", null).where("idle", "=", 0).limit(limit),
    ).rows.map(toFrame);
  }

  countUnbatchedActiveFrames(): number {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("frames")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("batch_id", "is", null)
        .where("idle", "=", 0),
    );
    return expectDefined(row, "Logbook unbatched frame count").n;
  }

  frameById(id: number): LogbookFrame | null {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.framesQuery.where("id", "=", id));
    return row ? toFrame(row) : null;
  }

  framesInRange(startMs: number, endMs: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("captured_at_ms", ">=", startMs).where("captured_at_ms", "<", endMs),
    ).rows.map(toFrame);
  }

  createBatch(params: LogbookBatchInput): number {
    if (params.frameIds.length === 0) {
      throw new Error("Logbook batch requires at least one frame");
    }
    const now = Date.now();
    return runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const result = this.statements.insertBatch({ ...params, now });
        const batchId = Number(expectDefined(result.insertId, "Logbook inserted batch ID"));
        for (const frameId of params.frameIds) {
          const assigned = this.statements.assignFrame({ batchId, frameId });
          if (expectDefined(assigned.numAffectedRows, "Logbook assigned frame count") !== 1n) {
            throw new Error(`Logbook frame ${frameId} is missing or already batched`);
          }
        }
        return batchId;
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.batch.create",
      },
    );
  }

  setBatchStatus(
    batchId: number,
    status: LogbookBatchStatus,
    error?: string,
    model?: string,
  ): void {
    this.statements.setBatchStatus({ batchId, status, error, model, now: Date.now() });
  }

  latestBatch(): LogbookBatch | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.batchesQuery.orderBy("id", "desc").limit(1),
    );
    return row ? toBatch(row) : null;
  }

  /** Requeues batches stuck in `running` after a crash so frames are not orphaned. */
  resetRunningBatches(): void {
    this.statements.resetRunningBatches(Date.now());
  }

  /** Requeues failed batches for an explicit user-driven retry (analyze now). */
  resetErrorBatches(): number {
    const result = this.statements.resetErrorBatches(Date.now());
    return Number(expectDefined(result.numAffectedRows, "Logbook reset batch count"));
  }

  nextPendingBatch(): LogbookBatch | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.batchesQuery
        .where("status", "=", "pending")
        .orderBy("start_ms", "asc")
        .orderBy("id", "asc")
        .limit(1),
    );
    return row ? toBatch(row) : null;
  }

  batchFrames(batchId: number): LogbookFrame[] {
    return executeSqliteQuerySync(
      this.db,
      this.framesQuery.where("batch_id", "=", batchId),
    ).rows.map(toFrame);
  }

  // Replace batch evidence atomically so manual retries cannot duplicate it.
  replaceObservations(batchId: number, day: string, segments: LogbookObservationInput[]): void {
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        this.statements.deleteObservations(batchId);
        for (const segment of segments) {
          this.statements.insertObservation({ ...segment, batchId, day });
        }
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.observations.replace",
      },
    );
  }

  observationsInRange(
    day: string,
    startMs: number,
    endMs: number,
    tailLimit?: number,
  ): LogbookObservation[] {
    const direction = tailLimit === undefined ? "asc" : "desc";
    let query = this.query
      .selectFrom("observations")
      .selectAll()
      .where("day", "=", day)
      .where("end_ms", ">", startMs)
      .where("start_ms", "<", endMs)
      .orderBy("start_ms", direction)
      .orderBy("id", direction);
    if (tailLimit !== undefined) {
      query = query.limit(tailLimit);
    }
    const rows = executeSqliteQuerySync(this.db, query).rows;
    // Reverse the stable timestamp/id tail so prompts keep their original chronology.
    if (tailLimit !== undefined) {
      rows.reverse();
    }
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      day: row.day,
      startMs: row.start_ms,
      endMs: row.end_ms,
      text: row.text,
    }));
  }

  cardsForDay(day: string, window?: { startMs: number; endMs: number }): LogbookCard[] {
    let query = this.cardsQuery
      .selectAll()
      .where("day", "=", day)
      .orderBy("start_ms", "asc")
      .orderBy("id", "asc");
    if (window) {
      query = query.where("end_ms", ">", window.startMs).where("start_ms", "<", window.endMs);
    }
    return executeSqliteQuerySync(this.db, query).rows.map(toCard);
  }

  countCardsForDay(day: string): number {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.cardsQuery.select((eb) => eb.fn.countAll<number>().as("count")).where("day", "=", day),
    );
    return expectDefined(row, "Logbook card count").count;
  }

  // Replace the overlapping window atomically so revision cannot expose partial timeline spans.
  replaceCardsInWindow(
    day: string,
    startMs: number,
    endMs: number,
    drafts: LogbookCardDraft[],
    selectKeyframes = false,
  ): void {
    const now = Date.now();
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const frames = selectKeyframes ? this.framesInRange(startMs, endMs) : undefined;
        this.statements.deleteCards({ day, startMs, endMs });
        for (const draft of drafts) {
          const keyframeId = frames ? pickKeyframeId(draft, frames) : draft.keyframeId;
          this.statements.insertCard({ ...draft, keyframeId, now });
        }
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.cards.replace",
      },
    );
  }

  listDays(): LogbookDay[] {
    return executeSqliteQuerySync(
      this.db,
      this.cardsQuery
        .select((eb) => [
          "day",
          eb.fn.countAll<number>().as("cards"),
          eb.fn.min<number>("start_ms").as("first_ms"),
          eb.fn.max<number>("end_ms").as("last_ms"),
        ])
        .groupBy("day")
        .orderBy("day", "desc"),
    ).rows.map((row) => ({
      day: row.day,
      cards: row.cards,
      firstMs: row.first_ms,
      lastMs: row.last_ms,
    }));
  }

  timelineForDay(day: string): LogbookTimeline {
    const cards = this.cardsForDay(day);
    const categories = new Map<string, number>();
    const apps = new Map<string, number>();
    let trackedMs = 0;
    let distractionMs = 0;
    for (const card of cards) {
      const duration = Math.max(0, card.endMs - card.startMs);
      trackedMs += duration;
      categories.set(card.category, (categories.get(card.category) ?? 0) + duration);
      if (card.appPrimary) {
        apps.set(card.appPrimary, (apps.get(card.appPrimary) ?? 0) + duration);
      }
      for (const distraction of card.distractions) {
        distractionMs += Math.max(0, distraction.endMs - distraction.startMs);
      }
    }
    const byMsDesc = (a: { ms: number }, b: { ms: number }) => b.ms - a.ms;
    return {
      day,
      cards,
      stats: {
        trackedMs,
        distractionMs,
        categories: [...categories.entries()]
          .map(([category, ms]) => ({ category, ms }))
          .toSorted(byMsDesc),
        apps: [...apps.entries()].map(([domain, ms]) => ({ domain, ms })).toSorted(byMsDesc),
      },
    };
  }

  getStandup(day: string): LogbookStandup | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("standups").selectAll().where("day", "=", day),
    );
    return row ? { day: row.day, text: row.text, updatedMs: row.updated_ms } : null;
  }

  saveStandup(day: string, text: string): void {
    this.statements.saveStandup({ day, text, now: Date.now() });
  }

  pruneFrames(olderThanMs: number): number {
    const rows = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("frames")
        .select(["id", "path", "day"])
        .where("captured_at_ms", "<", olderThanMs),
    ).rows;
    if (rows.length === 0) {
      return 0;
    }
    const days = new Set<string>();
    for (const row of rows) {
      // Keep metadata until every file is removed; force makes interrupted passes retryable.
      rmSync(row.path, { force: true });
      days.add(row.day);
    }
    const deleted = runSqliteImmediateTransactionSync(
      this.db,
      () => {
        let count = 0;
        for (let offset = 0; offset < rows.length; offset += FRAME_PRUNE_BATCH_SIZE) {
          const batch = rows.slice(offset, offset + FRAME_PRUNE_BATCH_SIZE);
          const ids = batch.map((row) => row.id);
          const currentPaths = new Map(
            executeSqliteQuerySync(
              this.db,
              this.query.selectFrom("frames").select(["id", "path"]).where("id", "in", ids),
            ).rows.map((row) => [row.id, row.path]),
          );
          for (const row of batch) {
            if (currentPaths.has(row.id) && currentPaths.get(row.id) !== row.path) {
              throw new Error(`Logbook frame ${row.id} changed path while pruning`);
            }
          }
          // ON DELETE SET NULL clears surviving cards' keyframes in the same commit.
          const result = executeSqliteQuerySync(
            this.db,
            this.query.deleteFrom("frames").where("id", "in", ids),
          );
          count += Number(expectDefined(result.numAffectedRows, "Logbook pruned frame count"));
        }
        return count;
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.frames.prune",
      },
    );
    for (const day of days) {
      // Best-effort: removes now-empty day directories, keeps non-empty ones.
      try {
        rmdirSync(path.join(this.framesDir, day));
      } catch {}
    }
    return deleted;
  }
}

export function createSqliteWorkerBackend(
  input: { dataDir: string },
  context: { databasePath: string },
): SqliteWorkerBackend<LogbookOperations> {
  const store = new LogbookDatabaseStore(input.dataDir, context.databasePath);
  return {
    execute(command) {
      switch (command.type) {
        case "insertFrame":
          return store.insertFrame(command.input);
        case "lastFrame":
          return store.lastFrame();
        case "unbatchedActiveFrames":
          return store.unbatchedActiveFrames(command.input.limit);
        case "countUnbatchedActiveFrames":
          return store.countUnbatchedActiveFrames();
        case "frameById":
          return store.frameById(command.input.id);
        case "framesInRange":
          return store.framesInRange(command.input.startMs, command.input.endMs);
        case "createBatch":
          return store.createBatch(command.input);
        case "setBatchStatus":
          return store.setBatchStatus(
            command.input.batchId,
            command.input.status,
            command.input.error,
            command.input.model,
          );
        case "latestBatch":
          return store.latestBatch();
        case "resetRunningBatches":
          return store.resetRunningBatches();
        case "resetErrorBatches":
          return store.resetErrorBatches();
        case "nextPendingBatch":
          return store.nextPendingBatch();
        case "batchFrames":
          return store.batchFrames(command.input.batchId);
        case "replaceObservations":
          return store.replaceObservations(
            command.input.batchId,
            command.input.day,
            command.input.segments,
          );
        case "observationsInRange":
          return store.observationsInRange(
            command.input.day,
            command.input.startMs,
            command.input.endMs,
            command.input.tailLimit,
          );
        case "cardsForDay":
          return store.cardsForDay(command.input.day, command.input.window);
        case "countCardsForDay":
          return store.countCardsForDay(command.input.day);
        case "replaceCardsInWindow":
          return store.replaceCardsInWindow(
            command.input.day,
            command.input.startMs,
            command.input.endMs,
            command.input.drafts,
            command.input.selectKeyframes,
          );
        case "listDays":
          return store.listDays();
        case "timelineForDay":
          return store.timelineForDay(command.input.day);
        case "getStandup":
          return store.getStandup(command.input.day);
        case "saveStandup":
          return store.saveStandup(command.input.day, command.input.text);
        case "pruneFrames":
          return store.pruneFrames(command.input.olderThanMs);
      }
    },
    close: () => store.close(),
  };
}
