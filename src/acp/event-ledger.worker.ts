import type { DatabaseSync } from "node:sqlite";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  prepareSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import { estimateAcpEventRowBytes, estimateAcpSessionRowBytes } from "./event-ledger-bytes.js";
import {
  normalizeAcpLedgerEvent,
  type AcpEventLedgerEntry,
  type AcpEventLedgerReplay,
} from "./event-ledger.types.js";
import type {
  AcpReplayAppendInput,
  AcpReplayStartInput,
  AcpReplayReadInput,
  AcpReplayLimits,
} from "./event-ledger.worker-contract.js";

function normalizeSqliteInteger(value: number | bigint | null): number {
  return value === null ? 0 : sqliteNumber(value);
}

type AcpLedgerDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "acp_replay_sessions" | "acp_replay_events"
>;
type AcpReplayEventRow = Pick<
  AcpLedgerDatabase["acp_replay_events"],
  "session_id" | "seq" | "at" | "session_key" | "run_id" | "update_json"
>;

type AcpReplaySessionRow = Pick<
  AcpLedgerDatabase["acp_replay_sessions"],
  "session_id" | "session_key" | "cwd" | "complete" | "next_seq"
>;

function createSqliteLedgerQueries(db: DatabaseSync) {
  const query = getNodeSqliteKysely<AcpLedgerDatabase>(db);
  return {
    readSession: prepareSqliteQuerySync<string, AcpReplaySessionRow>(db, (parameter) =>
      sqliteSessionMetadataQuery(db).where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
    ),
    deleteEvents: prepareSqliteQuerySync<string>(db, (parameter) =>
      query.deleteFrom("acp_replay_events").where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
    ),
    upsertSession: prepareSqliteQuerySync<{
      sessionId: string;
      sessionKey: string;
      cwd: string;
      complete: number;
      now: number;
      updatedAt: number;
      nextSeq: number;
      rowBytes: number;
    }>(db, (parameter) =>
      query
        .insertInto("acp_replay_sessions")
        .values({
          session_id: parameter((params) => params.sessionId),
          session_key: parameter((params) => params.sessionKey),
          cwd: parameter((params) => params.cwd),
          complete: parameter((params) => params.complete),
          created_at: parameter((params) => params.now),
          updated_at: parameter((params) => params.updatedAt),
          next_seq: parameter((params) => params.nextSeq),
          estimated_bytes: parameter((params) => params.rowBytes),
        })
        .onConflict((conflict) =>
          conflict.column("session_id").doUpdateSet((eb) => ({
            session_key: eb.ref("excluded.session_key"),
            cwd: eb.ref("excluded.cwd"),
            complete: eb.ref("excluded.complete"),
            updated_at: eb.ref("excluded.updated_at"),
            next_seq: eb.ref("excluded.next_seq"),
            estimated_bytes: eb.ref("excluded.estimated_bytes"),
          })),
        ),
    ),
    updateSessionMetadata: prepareSqliteQuerySync<{
      sessionId: string;
      sessionKey: string;
      cwd: string;
      complete: number;
      now: number;
      metadataDelta: number;
      sequenceDelta: number;
    }>(db, (parameter) =>
      query
        .updateTable("acp_replay_sessions")
        .set((eb) => ({
          estimated_bytes: eb(
            "estimated_bytes",
            "+",
            parameter((params) => params.metadataDelta),
          ),
          session_key: parameter((params) => params.sessionKey),
          cwd: parameter((params) => params.cwd),
          complete: parameter((params) => params.complete),
          updated_at: parameter((params) => params.now),
          next_seq: eb(
            "next_seq",
            "+",
            parameter((params) => params.sequenceDelta),
          ),
        }))
        .where(
          "session_id",
          "=",
          parameter((params) => params.sessionId),
        ),
    ),
    insertEvent: prepareSqliteQuerySync<{
      sessionId: string;
      seq: number;
      at: number;
      sessionKey: string;
      runId: string | null;
      updateJson: string;
      eventBytes: number;
    }>(db, (parameter) =>
      query.insertInto("acp_replay_events").values({
        session_id: parameter((params) => params.sessionId),
        seq: parameter((params) => params.seq),
        at: parameter((params) => params.at),
        session_key: parameter((params) => params.sessionKey),
        run_id: parameter((params) => params.runId),
        update_json: parameter((params) => params.updateJson),
        estimated_bytes: parameter((params) => params.eventBytes),
      }),
    ),
    readEventCapCandidates: prepareSqliteQuerySync<
      number,
      { session_id: string; event_count: number }
    >(db, (parameter) =>
      query
        .selectFrom("acp_replay_sessions as s")
        .select("s.session_id")
        .select((eb) =>
          eb
            .selectFrom("acp_replay_events as e")
            .select((count) => count.fn.count<number>("e.seq").as("event_count"))
            .whereRef("e.session_id", "=", "s.session_id")
            .as("event_count"),
        )
        .where((eb) => {
          const events = eb
            .selectFrom("acp_replay_events as e")
            .whereRef("e.session_id", "=", "s.session_id");
          return eb(
            eb(
              events.select((endpoint) => endpoint.fn.max<number>("e.seq").as("seq")),
              "-",
              events.select((endpoint) => endpoint.fn.min<number>("e.seq").as("seq")),
            ),
            ">=",
            parameter((limit) => limit),
          );
        }),
    ),
    readExcessSessions: prepareSqliteQuerySync<number, { session_id: string }>(db, (parameter) =>
      query
        .selectFrom("acp_replay_sessions")
        .select("session_id")
        .orderBy("updated_at", "desc")
        .orderBy("session_id", "asc")
        .limit(-1)
        .offset(parameter((limit) => limit)),
    ),
    readTotalBytes: prepareSqliteQuerySync<void, { total: number }>(db, () =>
      query
        .selectFrom("acp_replay_sessions")
        .select((eb) =>
          eb.fn.coalesce(eb.fn.sum<number>("estimated_bytes"), eb.val(0)).as("total"),
        ),
    ),
    readOldestSession: prepareSqliteQuerySync<void, { session_id: string }>(db, () =>
      query
        .selectFrom("acp_replay_sessions")
        .select("session_id")
        .orderBy("updated_at", "asc")
        .orderBy("session_id", "asc")
        .limit(1),
    ),
    deleteOldestEvents: prepareSqliteQuerySync<
      { sessionId: string; limit: number },
      { estimated_bytes: number }
    >(db, (parameter) => {
      const sessionId = parameter((params) => params.sessionId);
      return query
        .deleteFrom("acp_replay_events")
        .where("session_id", "=", sessionId)
        .where(
          "seq",
          "in",
          query
            .selectFrom("acp_replay_events")
            .select("seq")
            .where("session_id", "=", sessionId)
            .orderBy("seq", "asc")
            .limit(parameter((params) => params.limit)),
        )
        .returning("estimated_bytes");
    }),
    subtractSessionBytes: prepareSqliteQuerySync<{ sessionId: string; freed: number }>(
      db,
      (parameter) =>
        query
          .updateTable("acp_replay_sessions")
          .set((eb) => ({
            estimated_bytes: eb.fn<number>("max", [
              eb.val(0),
              eb(
                "estimated_bytes",
                "-",
                parameter((params) => params.freed),
              ),
            ]),
            complete: 0,
          }))
          .where(
            "session_id",
            "=",
            parameter((params) => params.sessionId),
          ),
    ),
    deleteSession: prepareSqliteQuerySync<string>(db, (parameter) =>
      query.deleteFrom("acp_replay_sessions").where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
    ),
  };
}

// Native statements and their invalidation remain owned by the shared executor cache.
const getSqliteLedgerQueries = createSqliteQueryCache(createSqliteLedgerQueries);

function sqliteRowToLedgerEvent(row: {
  [Key in keyof AcpReplayEventRow]: AcpReplayEventRow[Key] | null;
}): AcpEventLedgerEntry | undefined {
  let update: unknown;
  try {
    update = JSON.parse(row.update_json ?? "") as unknown;
  } catch {
    return undefined;
  }
  return normalizeAcpLedgerEvent({
    seq: normalizeSqliteInteger(row.seq),
    at: normalizeSqliteInteger(row.at),
    sessionId: row.session_id,
    sessionKey: row.session_key,
    ...(row.run_id ? { runId: row.run_id } : {}),
    update,
  });
}

function sqliteSessionMetadataQuery(db: DatabaseSync) {
  return getNodeSqliteKysely<AcpLedgerDatabase>(db)
    .selectFrom("acp_replay_sessions")
    .select(["session_id", "session_key", "cwd", "complete", "next_seq"]);
}

function readSqliteSessionById(db: DatabaseSync, sessionId: string) {
  return getSqliteLedgerQueries(db).readSession(sessionId).rows[0];
}

function upsertSqliteSession(
  db: DatabaseSync,
  now: number,
  params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    complete: boolean;
    reset?: boolean;
  },
  append?: { eventBytes: number; at: number },
): number {
  const existing = params.reset ? undefined : readSqliteSessionById(db, params.sessionId);
  if (existing) {
    const cwd = params.cwd || existing.cwd;
    const complete = normalizeSqliteInteger(existing.complete) === 1 || params.complete ? 1 : 0;
    const metadataDelta =
      estimateAcpSessionRowBytes({ ...params, cwd }) -
      estimateAcpSessionRowBytes({
        sessionId: params.sessionId,
        sessionKey: existing.session_key,
        cwd: existing.cwd,
      });
    getSqliteLedgerQueries(db).updateSessionMetadata({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      cwd,
      complete,
      now: append?.at ?? now,
      metadataDelta: metadataDelta + (append?.eventBytes ?? 0),
      sequenceDelta: append ? 1 : 0,
    });
    return normalizeSqliteInteger(existing.next_seq);
  }

  if (params.reset) {
    getSqliteLedgerQueries(db).deleteEvents(params.sessionId);
  }
  // Missing sessions have no events; reset deletes them in this same transaction.
  const rowBytes = estimateAcpSessionRowBytes(params);
  getSqliteLedgerQueries(db).upsertSession({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cwd: params.cwd,
    complete: params.complete ? 1 : 0,
    now,
    updatedAt: append?.at ?? now,
    nextSeq: append ? 2 : 1,
    rowBytes: rowBytes + (append?.eventBytes ?? 0),
  });
  return 1;
}

// Session rows carry a running footprint aggregate (row overhead plus their
// event rows), maintained at insert/trim time. The budget check therefore
// sums over at most maxSessions rows instead of scanning every event per
// append, which was O(events) per message and quadratic while trimming.
function estimateSqliteLedgerBytes(db: DatabaseSync): number {
  const row = getSqliteLedgerQueries(db).readTotalBytes().rows[0];
  return normalizeSqliteInteger(row?.total ?? 0);
}

const LEDGER_TRIM_EVENT_BATCH = 64;

// Keep the session's byte aggregate in sync with the deletion in the same transaction.
function deleteOldestSqliteEvents(db: DatabaseSync, sessionId: string, limit: number): number {
  const queries = getSqliteLedgerQueries(db);
  const rows = queries.deleteOldestEvents({ sessionId, limit }).rows;
  if (rows.length === 0) {
    return 0;
  }
  const freed = rows.reduce((sum, row) => sum + normalizeSqliteInteger(row.estimated_bytes), 0);
  queries.subtractSessionBytes({ sessionId, freed });
  return rows.length;
}

function trimSqliteLedger(db: DatabaseSync, state: AcpReplayLimits): void {
  // Indexed sequence endpoints bound the count even when retained sequences have
  // gaps. Only histories that could exceed the cap need an exact count.
  const queries = getSqliteLedgerQueries(db);
  const eventCapCandidates = queries.readEventCapCandidates(state.maxEventsPerSession).rows;
  for (const row of eventCapCandidates) {
    const overage = normalizeSqliteInteger(row.event_count) - state.maxEventsPerSession;
    if (overage > 0) {
      deleteOldestSqliteEvents(db, row.session_id, overage);
    }
  }

  const oldSessions = queries.readExcessSessions(state.maxSessions).rows;
  for (const session of oldSessions) {
    queries.deleteSession(session.session_id);
  }

  // Byte budget: evict from the least-recently-updated session in bounded
  // batches, dropping the session row itself once its events are exhausted.
  // Aggregates keep every recheck O(maxSessions); no event scans occur.
  let serializedBytes = estimateSqliteLedgerBytes(db);
  while (serializedBytes > state.maxSerializedBytes) {
    const session = queries.readOldestSession().rows[0];
    if (!session) {
      break;
    }
    const deleted = deleteOldestSqliteEvents(db, session.session_id, LEDGER_TRIM_EVENT_BATCH);
    if (deleted === 0) {
      queries.deleteSession(session.session_id);
    }
    serializedBytes = estimateSqliteLedgerBytes(db);
  }
}

function appendSqliteUpdate(
  db: DatabaseSync,
  state: AcpReplayLimits,
  params: AcpReplayAppendInput["events"][number] & {
    sessionId: string;
    sessionKey: string;
    runId?: string;
  },
): void {
  const updateJson = JSON.stringify(params.update);
  const eventBytes = estimateAcpEventRowBytes({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    ...(params.runId !== undefined ? { runId: params.runId } : {}),
    updateJson,
  });
  const nextSeq = upsertSqliteSession(
    db,
    params.createdAt,
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      cwd: "",
      complete: false,
    },
    { eventBytes, at: params.at },
  );
  getSqliteLedgerQueries(db).insertEvent({
    sessionId: params.sessionId,
    seq: nextSeq,
    at: params.at,
    sessionKey: params.sessionKey,
    runId: params.runId ?? null,
    updateJson,
    eventBytes,
  });
  trimSqliteLedger(db, state);
}

function readSqliteReplay(db: DatabaseSync, input: AcpReplayReadInput): AcpEventLedgerReplay {
  const query = getNodeSqliteKysely<AcpLedgerDatabase>(db);
  let selected = query
    .selectFrom("acp_replay_sessions")
    .select(["session_id", "session_key"])
    .where("complete", "=", 1);
  if (input.kind === "key") {
    selected = selected
      .where("session_key", "=", input.sessionKey)
      .orderBy("updated_at", "desc")
      .orderBy("session_id", "asc");
  } else {
    selected = selected.where("session_id", "=", input.sessionId);
    if (input.kind === "bound") {
      selected = selected.where("session_key", "=", input.sessionKey);
    }
  }
  // Eligibility and payload share one statement's snapshot; incomplete sessions
  // never join their history, and empty complete sessions retain their identity.
  const rows = executeSqliteQuerySync(
    db,
    query
      .selectFrom(selected.limit(1).as("session"))
      .leftJoin("acp_replay_events as event", "event.session_id", "session.session_id")
      .select([
        "session.session_id as replay_session_id",
        "session.session_key as replay_session_key",
        "event.session_id",
        "event.seq",
        "event.at",
        "event.session_key",
        "event.run_id",
        "event.update_json",
      ])
      .orderBy("event.seq", "asc"),
  ).rows;
  const session = rows[0];
  return session
    ? {
        complete: true,
        sessionId: session.replay_session_id,
        sessionKey: session.replay_session_key,
        events: rows.flatMap((row) => {
          const event = sqliteRowToLedgerEvent(row);
          return event ? [event] : [];
        }),
      }
    : { complete: false, events: [] };
}

export const acpReplayOperations = {
  "acpReplay.start": (input: AcpReplayStartInput, { write }) =>
    write(
      (database) => {
        upsertSqliteSession(database.db, input.now, input.session);
        trimSqliteLedger(database.db, input.limits);
      },
      { operationLabel: "acp.replay.start" },
    ),
  "acpReplay.append": (input: AcpReplayAppendInput, { write }) =>
    write(
      (database) => {
        for (const event of input.events) {
          appendSqliteUpdate(database.db, input.limits, { ...event, ...input.session });
        }
      },
      { operationLabel: "acp.replay.append" },
    ),
  "acpReplay.incomplete": (
    input: { sessionId: string; sessionKey: string; now: number },
    { write },
  ) =>
    write(
      (database) => {
        executeSqliteQuerySync(
          database.db,
          getNodeSqliteKysely<AcpLedgerDatabase>(database.db)
            .updateTable("acp_replay_sessions")
            .set({ complete: 0, updated_at: input.now })
            .where("session_id", "=", input.sessionId)
            .where("session_key", "=", input.sessionKey),
        );
      },
      { operationLabel: "acp.replay.incomplete" },
    ),
  "acpReplay.read": (input: AcpReplayReadInput, { open }) => readSqliteReplay(open().db, input),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
