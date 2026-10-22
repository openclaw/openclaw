import { chmodSync, mkdirSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  runEngineWorkerWrite,
  type DatabaseEngineInput,
  type EngineConnection,
} from "openclaw/plugin-sdk/database-engine-worker-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
  runSqliteImmediateTransactionSync,
  requestSqliteWorkerOperationAdmission,
  type SqliteWorkerBackend,
  type SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { pickKeyframeId } from "./analyze.js";
import { isLogbookWriteOperation } from "./store-contract.js";
import type {
  LogbookBatchInput,
  LogbookDay,
  LogbookFrameInput,
  LogbookOperations,
  LogbookStandup,
  LogbookTimeline,
} from "./store-contract.js";
import { createLogbookFrameQueries } from "./store-frame-queries.js";
import { createLogbookDatabase, LOGBOOK_SQLITE_BUSY_TIMEOUT_MS } from "./store-schema-admission.js";
import { toBatch, toCard, toFrame, type LogbookDatabase } from "./store-schema.js";
import type { LogbookBatch, LogbookCard, LogbookFrame, LogbookObservation } from "./types.js";

// Twelve card columns keep each batch below SQLite’s parameter limit.
const WRITE_BATCH_SIZE = 64;
const FRAME_PRUNE_BATCH_SIZE = 64;
class LogbookDatabaseStore {
  private readonly db: EngineConnection;
  private readonly query;
  private readonly framesQuery;
  private readonly frameMetadataQuery;
  private readonly batchesQuery;
  private readonly cardsQuery;
  private readonly statements;
  private readonly database: ReturnType<typeof createLogbookDatabase>;
  readonly framesDir: string;

  constructor(dataDir: string, dbPath: string, input?: DatabaseEngineInput) {
    // Screen captures and their database remain owner-only even in a permissive state directory.
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
    this.framesDir = path.join(dataDir, "frames");
    mkdirSync(this.framesDir, { recursive: true, mode: 0o700 });
    chmodSync(this.framesDir, 0o700);
    const database = createLogbookDatabase(dbPath, input);
    const { db } = database;
    try {
      this.db = db;
      this.database = database;
      this.query = getNodeSqliteKysely<LogbookDatabase>(db);
      const { framesQuery, sampledBatchFrames } = createLogbookFrameQueries(db, this.query);
      this.framesQuery = framesQuery;
      // Keep native integer overflow rejection while omitting unused frame strings.
      this.frameMetadataQuery = framesQuery
        .clearSelect()
        .select(["id", "captured_at_ms", "screen_index", "width", "height", "byte_size", "idle"]);
      this.batchesQuery = this.query
        .selectFrom("batches")
        .select(["id", "day", "start_ms", "end_ms", "status", "error", "frame_count", "model"]);
      this.cardsQuery = this.query.selectFrom("cards");
      this.statements = {
        sampledBatchFrames,
        insertFrame: prepareSqliteQuerySync<LogbookFrameInput, { id: number }>(db, (p) =>
          this.query
            .insertInto("frames")
            .values({
              captured_at_ms: p((row) => row.capturedAtMs),
              day: p((row) => row.day),
              path: p((row) => row.path),
              screen_index: p((row) => row.screenIndex),
              width: p((row) => row.width ?? null),
              height: p((row) => row.height ?? null),
              byte_size: p((row) => row.byteSize),
              content_hash: p((row) => row.contentHash),
              idle: p((row) => (row.idle ? 1 : 0)),
            })
            .returning("id"),
        ),
        insertBatch: prepareSqliteQuerySync<LogbookBatchInput & { now: number }, { id: number }>(
          db,
          (p) =>
            this.query
              .insertInto("batches")
              .values({
                day: p((row) => row.day),
                start_ms: p((row) => row.startMs),
                end_ms: p((row) => row.endMs),
                status: "pending",
                frame_count: p((row) => row.frameIds.length),
                created_ms: p((row) => row.now),
                updated_ms: p((row) => row.now),
              })
              .returning("id"),
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
      void database.close().catch(() => {});
      throw error;
    }
  }

  get connection(): EngineConnection {
    return this.db;
  }

  close(): Promise<void> {
    return this.database.close();
  }

  insertFrame(params: LogbookFrameInput): number {
    const result = this.statements.insertFrame(params);
    return expectDefined(result.rows[0], "Logbook inserted frame").id;
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

  unbatchedActiveFrames({
    limit,
  }: LogbookOperations["unbatchedActiveFrames"]["input"]): Pick<
    LogbookFrame,
    "id" | "capturedAtMs"
  >[] {
    return executeSqliteQuerySync(
      this.db,
      this.frameMetadataQuery.where("batch_id", "is", null).where("idle", "=", 0).limit(limit),
    ).rows.map((row) => ({ id: row.id, capturedAtMs: row.captured_at_ms }));
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

  frameById({ id }: LogbookOperations["frameById"]["input"]): LogbookFrame | null {
    const row = executeSqliteQueryTakeFirstSync(this.db, this.framesQuery.where("id", "=", id));
    return row ? toFrame(row) : null;
  }

  framesInRange({
    startMs,
    endMs,
  }: LogbookOperations["framesInRange"]["input"]): Pick<
    LogbookFrame,
    "id" | "capturedAtMs" | "idle"
  >[] {
    return executeSqliteQuerySync(
      this.db,
      this.frameMetadataQuery
        .where("captured_at_ms", ">=", startMs)
        .where("captured_at_ms", "<", endMs),
    ).rows.map((row) => ({
      id: row.id,
      capturedAtMs: row.captured_at_ms,
      idle: row.idle === 1,
    }));
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
        const batchId = expectDefined(result.rows[0], "Logbook inserted batch").id;
        for (let offset = 0; offset < params.frameIds.length; offset += WRITE_BATCH_SIZE) {
          const frameIds = params.frameIds.slice(offset, offset + WRITE_BATCH_SIZE);
          const assigned = executeSqliteQuerySync(
            this.db,
            this.query
              .updateTable("frames")
              .set({ batch_id: batchId })
              .where("id", "in", frameIds)
              .where("batch_id", "is", null)
              .returning("id"),
          );
          const assignedIds = new Set(assigned.rows.map((row) => row.id));
          for (const frameId of frameIds) {
            if (!assignedIds.delete(frameId)) {
              throw new Error(`Logbook frame ${frameId} is missing or already batched`);
            }
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

  setBatchStatus(input: LogbookOperations["setBatchStatus"]["input"]): void {
    this.statements.setBatchStatus({ ...input, now: Date.now() });
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

  sampledBatchFrames({
    batchId,
  }: LogbookOperations["sampledBatchFrames"]["input"]): LogbookFrame[] {
    // The ordinal scan and sampled payload read share one statement.
    return this.statements.sampledBatchFrames(batchId).rows.map(toFrame);
  }

  // Replace batch evidence atomically so manual retries cannot duplicate it.
  replaceObservations({
    batchId,
    day,
    segments,
  }: LogbookOperations["replaceObservations"]["input"]): void {
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        this.statements.deleteObservations(batchId);
        for (let offset = 0; offset < segments.length; offset += WRITE_BATCH_SIZE) {
          executeSqliteQuerySync(
            this.db,
            this.query.insertInto("observations").values(
              segments.slice(offset, offset + WRITE_BATCH_SIZE).map((segment) => ({
                batch_id: batchId,
                day,
                start_ms: segment.startMs,
                end_ms: segment.endMs,
                text: segment.text,
              })),
            ),
          );
        }
      },
      {
        busyTimeoutMs: LOGBOOK_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "logbook",
        operationLabel: "logbook.observations.replace",
      },
    );
  }

  observationsInRange({
    day,
    startMs,
    endMs,
    tailLimit,
  }: LogbookOperations["observationsInRange"]["input"]): LogbookObservation[] {
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

  cardsForDay({ day, window }: LogbookOperations["cardsForDay"]["input"]): LogbookCard[] {
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

  countCardsForDay({ day }: LogbookOperations["countCardsForDay"]["input"]): number {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.cardsQuery.select((eb) => eb.fn.countAll<number>().as("count")).where("day", "=", day),
    );
    return expectDefined(row, "Logbook card count").count;
  }

  // Replace the overlapping window atomically so revision cannot expose partial timeline spans.
  replaceCardsInWindow({
    day,
    startMs,
    endMs,
    drafts,
  }: LogbookOperations["replaceCardsInWindow"]["input"]): void {
    const now = Date.now();
    runSqliteImmediateTransactionSync(
      this.db,
      () => {
        const frames = executeSqliteQuerySync(
          this.db,
          this.frameMetadataQuery
            .where("captured_at_ms", ">=", startMs)
            .where("captured_at_ms", "<", endMs),
        ).rows.map((row) => ({ id: row.id, capturedAtMs: row.captured_at_ms }));
        this.statements.deleteCards({ day, startMs, endMs });
        for (let offset = 0; offset < drafts.length; offset += WRITE_BATCH_SIZE) {
          executeSqliteQuerySync(
            this.db,
            this.query.insertInto("cards").values(
              drafts.slice(offset, offset + WRITE_BATCH_SIZE).map((draft) => ({
                day: draft.day,
                start_ms: draft.startMs,
                end_ms: draft.endMs,
                title: draft.title,
                summary: draft.summary,
                detail: draft.detail,
                category: draft.category,
                app_primary: draft.appPrimary ?? null,
                app_secondary: draft.appSecondary ?? null,
                distractions: JSON.stringify(draft.distractions),
                keyframe_id: pickKeyframeId(draft, frames) ?? null,
                updated_ms: now,
              })),
            ),
          );
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

  timelineForDay({ day }: LogbookOperations["timelineForDay"]["input"]): LogbookTimeline {
    const cards = this.cardsForDay({ day });
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

  getStandup({ day }: LogbookOperations["getStandup"]["input"]): LogbookStandup | null {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("standups").selectAll().where("day", "=", day),
    );
    return row ? { day: row.day, text: row.text, updatedMs: row.updated_ms } : null;
  }

  saveStandup({ day, text }: LogbookOperations["saveStandup"]["input"]): LogbookStandup {
    const updatedMs = Date.now();
    this.statements.saveStandup({ day, text, now: updatedMs });
    return { day, text, updatedMs };
  }

  pruneFrames({ olderThanMs }: LogbookOperations["pruneFrames"]["input"]): number {
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
  input: { dataDir: string; postgresInput?: DatabaseEngineInput },
  context: { databasePath: string },
): SqliteWorkerBackend<LogbookOperations> {
  const store = new LogbookDatabaseStore(input.dataDir, context.databasePath, input.postgresInput);
  const operations: {
    [Key in keyof LogbookOperations]: (
      input: LogbookOperations[Key]["input"],
    ) => LogbookOperations[Key]["output"];
  } = store;
  function dispatch<Key extends keyof LogbookOperations>(
    command: SqliteWorkerCommand<Pick<LogbookOperations, Key>>,
  ): LogbookOperations[Key]["output"] {
    return operations[command.type](command.input);
  }
  return {
    execute(command) {
      const execute = () => dispatch(command);
      return isLogbookWriteOperation(command.type)
        ? runEngineWorkerWrite(input.postgresInput, execute, (operation) => {
            requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
            return runSqliteImmediateTransactionSync(store.connection, operation, {
              withCommit(commit) {
                requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
                commit();
              },
            });
          })
        : execute();
    },
    close: () => store.close(),
  };
}
