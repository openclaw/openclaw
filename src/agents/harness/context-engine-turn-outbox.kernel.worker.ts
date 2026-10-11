import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import {
  readClosedTranscriptTurnInDatabase,
  type ClosedTranscriptTurnReadResult,
} from "../../config/sessions/session-accessor.transcript-range.js";
import type { TranscriptTurnBoundary } from "../../config/sessions/transcript-entry-anchor.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { ensureContextEngineTurnOutboxSchema } from "../../state/openclaw-agent-context-engine-turn-outbox-schema.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";
import {
  isRetryableContextEngineTurnReadFailure,
  type AcceptedContextEngineTurnOutboxPayload,
  type BlockedContextEngineTurnOutboxPayload,
  type ContextEngineTurnOutboxFilter,
  type ContextEngineTurnOutboxPayload,
  type ContextEngineTurnOutboxWorkerOperations,
  type ContextEngineTurnReadFailureKind,
  type PendingContextEngineTurn,
  type ReadyContextEngineTurnOutboxPayload,
} from "./context-engine-turn-outbox.js";

type ContextEngineTurnOutboxDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  "context_engine_turn_outbox"
>;

/** Outbox kernels need only the connection; workers pass their borrowed one. */
type ContextEngineTurnOutboxConnection = Pick<OpenClawAgentDatabase, "db">;

type OutboxKernelParams<Type extends keyof ContextEngineTurnOutboxWorkerOperations> =
  ContextEngineTurnOutboxWorkerOperations[Type]["input"] & {
    database: ContextEngineTurnOutboxConnection;
  };

const RECOVERED_TURN_MAX_EVENTS = 20_000;
const RECOVERED_TURN_MAX_BYTES = 8 * 1024 * 1024;

function outboxEnqueueSequence() {
  return /* kysely-allow-raw: SQLite's implicit rowid is the durable enqueue sequence for this table. */ sql<number>`context_engine_turn_outbox.rowid`;
}

function oldestOutboxEnqueueSequence() {
  return /* kysely-allow-raw: Aggregate the closed implicit-rowid expression used for enqueue order. */ sql<number>`MIN(context_engine_turn_outbox.rowid)`;
}

function outboxPayloadRequiresAdvancement() {
  // Blocked rows are terminal audit evidence, not retryable work. Keep them
  // inspectable without letting them hold later same-session turns behind them.
  return /* kysely-allow-raw: Payload state is owned by the closed outbox union above. */ sql<boolean>`json_extract(context_engine_turn_outbox.payload_json, '$.state') IS NOT 'blocked'`;
}

function outboxDb(database: ContextEngineTurnOutboxConnection) {
  ensureContextEngineTurnOutboxSchema(database.db);
  return getNodeSqliteKysely<ContextEngineTurnOutboxDatabase>(database.db);
}

function assertMatchingOutboxOwner(
  existing: { engine_id: string; owner_plugin_id: string | null },
  params: ContextEngineTurnOutboxFilter,
  advancementKey: string,
): void {
  if (
    existing.engine_id !== params.engineId ||
    existing.owner_plugin_id !== (params.ownerPluginId ?? null)
  ) {
    throw new Error(`context-engine advancement key collision: ${advancementKey}`);
  }
}

function writeContextEngineTurnOutboxPayload(
  params: ContextEngineTurnOutboxFilter & {
    database: ContextEngineTurnOutboxConnection;
    payload: ContextEngineTurnOutboxPayload;
  },
): void {
  const db = outboxDb(params.database);
  const admission =
    params.payload.state === "admitted"
      ? params.payload.admission
      : params.payload.boundary.admission;
  const advancementKey = admission.logicalTurnId;
  const payloadJson = JSON.stringify(params.payload);
  const existing = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["engine_id", "owner_plugin_id", "payload_json"])
      .where("advancement_key", "=", advancementKey),
  );
  if (existing) {
    assertMatchingOutboxOwner(existing, params, advancementKey);
    // SAFETY: This module's typed writers own the persisted outbox payload union.
    const existingPayload = JSON.parse(existing.payload_json) as ContextEngineTurnOutboxPayload;
    const transitionMatches =
      (params.payload.state === "accepted" &&
        existingPayload.state === "admitted" &&
        existingPayload.admission.entryId === admission.entryId) ||
      ((params.payload.state === "blocked" || params.payload.state === "ready") &&
        existingPayload.state === "accepted" &&
        existingPayload.boundary.admission.entryId === admission.entryId &&
        existingPayload.boundary.terminal.entryId === params.payload.boundary.terminal.entryId);
    if (transitionMatches) {
      executeSqliteQuerySync(
        params.database.db,
        db
          .updateTable("context_engine_turn_outbox")
          .set({
            attempt_count: 0,
            last_attempt_at: null,
            last_error: null,
            payload_json: payloadJson,
          })
          .where("advancement_key", "=", advancementKey),
      );
      return;
    }
    if (existing.payload_json !== payloadJson) {
      throw new Error(`context-engine advancement key collision: ${advancementKey}`);
    }
    return;
  }
  executeSqliteQuerySync(
    params.database.db,
    db
      .insertInto("context_engine_turn_outbox")
      .values({
        advancement_key: advancementKey,
        engine_id: params.engineId,
        owner_plugin_id: params.ownerPluginId ?? null,
        session_id: admission.sessionId,
        payload_json: payloadJson,
        created_at: Date.now(),
        last_attempt_at: null,
        last_error: null,
      })
      .onConflict((conflict) => conflict.column("advancement_key").doNothing()),
  );
}

export function enqueueContextEngineTurnIntent(params: OutboxKernelParams<"enqueueIntent">): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: {
      admission: params.admission,
      isHeartbeat: params.isHeartbeat,
      state: "admitted",
    },
  });
}

export function acceptContextEngineTurnIntent(params: OutboxKernelParams<"acceptIntent">): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: {
      boundary: params.boundary,
      isHeartbeat: params.isHeartbeat,
      state: "accepted",
      runtimeContext: params.runtimeContext,
    },
  });
}

export function enqueueContextEngineTurnCommit(params: {
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  ownerPluginId?: string;
  payload: Omit<ReadyContextEngineTurnOutboxPayload, "state">;
}): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: { ...params.payload, state: "ready" },
  });
}

function blockContextEngineTurnIntent(
  params: ContextEngineTurnOutboxFilter & {
    boundary: TranscriptTurnBoundary;
    database: ContextEngineTurnOutboxConnection;
    failure: BlockedContextEngineTurnOutboxPayload["failure"];
    isHeartbeat: boolean;
  },
): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: {
      boundary: params.boundary,
      failure: params.failure,
      isHeartbeat: params.isHeartbeat,
      state: "blocked",
    },
  });
}

function discardContextEngineTurnIntent(params: OutboxKernelParams<"discardIntent">): boolean {
  const db = outboxDb(params.database);
  const result = executeSqliteQuerySync(
    params.database.db,
    db
      .deleteFrom("context_engine_turn_outbox")
      .where("advancement_key", "=", params.admission.logicalTurnId)
      .where("engine_id", "=", params.engineId)
      // Accepted work remains recoverable when publication or acknowledgment fails.
      .where(
        /* kysely-allow-raw: Closed outbox payload state. */ sql`json_extract(payload_json, '$.state')`,
        "=",
        "admitted",
      )
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null),
  );
  return result.numAffectedRows !== undefined && result.numAffectedRows > 0n;
}

/**
 * Reads an accepted turn's bounded range and publishes it as ready or blocked.
 * The acceptance commits first in its own transaction, so a failed read or
 * publication leaves the turn accepted and the next recovery advances it.
 */
function publishClosedContextEngineTurn(
  params: OutboxKernelParams<"publishClosedTurn">,
): ClosedTranscriptTurnReadResult["kind"] {
  // Recovery can replay this publication; the engine owns logical-turn idempotency.
  return advanceAcceptedContextEngineTurn(params, params, params);
}

function advanceAcceptedContextEngineTurn(
  owner: ContextEngineTurnOutboxFilter & { database: ContextEngineTurnOutboxConnection },
  payload: Omit<AcceptedContextEngineTurnOutboxPayload, "state">,
  limits: { maxEvents: number; maxBytes: number },
  onReadFailure?: (kind: ContextEngineTurnReadFailureKind) => void,
): ClosedTranscriptTurnReadResult["kind"] {
  const closedTurn = readClosedTranscriptTurnInDatabase(owner.database.db, {
    boundary: payload.boundary,
    maxEvents: limits.maxEvents,
    maxBytes: limits.maxBytes,
  });
  if (closedTurn.kind !== "ok") {
    onReadFailure?.(closedTurn.kind);
    if (!isRetryableContextEngineTurnReadFailure(closedTurn.kind)) {
      blockContextEngineTurnIntent({
        boundary: payload.boundary,
        database: owner.database,
        engineId: owner.engineId,
        failure: closedTurn.kind,
        isHeartbeat: payload.isHeartbeat,
        ownerPluginId: owner.ownerPluginId,
      });
    }
    return closedTurn.kind;
  }
  enqueueContextEngineTurnCommit({
    database: owner.database,
    engineId: owner.engineId,
    ownerPluginId: owner.ownerPluginId,
    payload: {
      boundary: payload.boundary,
      isHeartbeat: payload.isHeartbeat,
      messages: closedTurn.messages,
      runtimeContext: payload.runtimeContext,
    },
  });
  return closedTurn.kind;
}

export function recoverContextEngineTurnOutbox(params: {
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  ownerPluginId?: string;
  sessionId: string;
  warn: (message: string) => void;
}): boolean {
  const db = outboxDb(params.database);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["advancement_key", "payload_json"])
      .where("engine_id", "=", params.engineId)
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null)
      .where("session_id", "=", params.sessionId)
      // Blocked rows are terminal; their outcome was logged once when the turn was blocked.
      .where(outboxPayloadRequiresAdvancement())
      .orderBy(outboxEnqueueSequence(), "asc"),
  ).rows;
  let pending = false;
  for (const row of rows) {
    // SAFETY: This module's typed writers own the persisted outbox payload union.
    const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
    if (payload.state === "ready") {
      pending = true;
      continue;
    }
    if (payload.state === "blocked") {
      continue;
    }
    if (payload.state === "admitted") {
      // Admission proves provider dispatch only. Without the host-owned accepted
      // transition, later descendants may belong to a rejected fallback attempt.
      discardContextEngineTurnIntent({
        admission: payload.admission,
        database: params.database,
        engineId: params.engineId,
        ownerPluginId: params.ownerPluginId,
      });
      params.warn(
        `[context-engine] discarded unaccepted turn advancement: ${row.advancement_key}: recovery found no host acceptance`,
      );
      continue;
    }
    const result = advanceAcceptedContextEngineTurn(
      params,
      payload,
      {
        maxEvents: RECOVERED_TURN_MAX_EVENTS,
        maxBytes: RECOVERED_TURN_MAX_BYTES,
      },
      (kind) =>
        params.warn(
          isRetryableContextEngineTurnReadFailure(kind)
            ? `[context-engine] durable turn recovery remains queued: ${row.advancement_key}: transcript range is ${kind}`
            : `[context-engine] blocked unrecoverable turn advancement: ${row.advancement_key}: transcript range is ${kind}`,
        ),
    );
    pending ||= result === "ok" || isRetryableContextEngineTurnReadFailure(result);
  }
  return pending;
}

function listPendingContextEngineTurnSessions(
  database: ContextEngineTurnOutboxConnection,
  filter: ContextEngineTurnOutboxFilter & { sessionId?: string; limit: number },
): string[] {
  const query = pendingContextEngineTurns(database, filter, filter.sessionId || undefined)
    .select("session_id")
    // SQLite rowid preserves enqueue order among surviving pending rows.
    // Use it instead of wall-clock timestamps, which can collide.
    .select(oldestOutboxEnqueueSequence().as("oldest_enqueue_sequence"));
  return executeSqliteQuerySync(
    database.db,
    query.groupBy("session_id").orderBy("oldest_enqueue_sequence", "asc").limit(filter.limit),
  ).rows.map(({ session_id }) => session_id);
}

function readNextPendingContextEngineTurn(
  database: ContextEngineTurnOutboxConnection,
  filter: ContextEngineTurnOutboxFilter & { sessionId: string },
): PendingContextEngineTurn | undefined {
  return executeSqliteQueryTakeFirstSync(
    database.db,
    pendingContextEngineTurns(database, filter, filter.sessionId)
      .select(["advancement_key", "payload_json", "session_id"])
      .orderBy(outboxEnqueueSequence(), "asc")
      .limit(1),
  );
}

function completeContextEngineTurn(
  database: ContextEngineTurnOutboxConnection,
  advancementKey: string,
): void {
  executeSqliteQuerySync(
    database.db,
    outboxDb(database)
      .deleteFrom("context_engine_turn_outbox")
      .where("advancement_key", "=", advancementKey),
  );
}

function recordContextEngineTurnFailure(
  database: ContextEngineTurnOutboxConnection,
  advancementKey: string,
  message: string,
  attemptedAt: number,
): void {
  executeSqliteQuerySync(
    database.db,
    outboxDb(database)
      .updateTable("context_engine_turn_outbox")
      .set((eb) => ({
        attempt_count: eb("attempt_count", "+", 1),
        last_attempt_at: attemptedAt,
        last_error: message,
      }))
      .where("advancement_key", "=", advancementKey),
  );
}

function pendingContextEngineTurns(
  database: ContextEngineTurnOutboxConnection,
  filter: ContextEngineTurnOutboxFilter,
  sessionId: string | undefined,
) {
  const query = outboxDb(database)
    .selectFrom("context_engine_turn_outbox")
    .where("engine_id", "=", filter.engineId)
    .where("owner_plugin_id", filter.ownerPluginId ? "=" : "is", filter.ownerPluginId ?? null)
    .where(outboxPayloadRequiresAdvancement());
  return sessionId === undefined ? query : query.where("session_id", "=", sessionId);
}

function hasPendingContextEngineTurn(
  database: ContextEngineTurnOutboxConnection,
  filter: ContextEngineTurnOutboxFilter & { sessionId?: string },
): boolean {
  const query = pendingContextEngineTurns(database, filter, filter.sessionId || undefined).select(
    "advancement_key",
  );
  return executeSqliteQueryTakeFirstSync(database.db, query.limit(1)) !== undefined;
}

/**
 * Recovers a session's outbox before a run and, when nothing remains to
 * advance, records the known admission in the same transaction. The common
 * turn start therefore needs one database round trip.
 */
function prepareContextEngineTurnRun(
  params: OutboxKernelParams<"prepareRun">,
): ContextEngineTurnOutboxWorkerOperations["prepareRun"]["output"] {
  const warnings: string[] = [];
  const pending = recoverContextEngineTurnOutbox({
    ...params,
    warn: (message) => warnings.push(message),
  });
  if (pending || !params.admission) {
    return { warnings, pending, admitted: false };
  }
  enqueueContextEngineTurnIntent({ ...params, admission: params.admission });
  return { warnings, pending, admitted: true };
}

type OutboxCommand = SqliteWorkerCommand<ContextEngineTurnOutboxWorkerOperations>;
type OutboxOutput =
  ContextEngineTurnOutboxWorkerOperations[keyof ContextEngineTurnOutboxWorkerOperations]["output"];

/** Runs one outbox command's kernel on the borrowed connection. */
export function executeContextEngineTurnOutboxCommand(
  db: DatabaseSync,
  command: OutboxCommand,
): OutboxOutput {
  const database = { db };
  switch (command.type) {
    case "prepareRun":
      return prepareContextEngineTurnRun({ ...command.input, database });
    case "listPendingSessions":
      return listPendingContextEngineTurnSessions(database, command.input);
    case "readNextPending":
      return readNextPendingContextEngineTurn(database, command.input);
    case "complete":
      completeContextEngineTurn(database, command.input.advancementKey);
      return undefined;
    case "recordFailure":
      recordContextEngineTurnFailure(
        database,
        command.input.advancementKey,
        command.input.message,
        command.input.attemptedAt,
      );
      return undefined;
    case "hasPending":
      return hasPendingContextEngineTurn(database, command.input);
    case "enqueueIntent":
      enqueueContextEngineTurnIntent({ ...command.input, database });
      return undefined;
    case "acceptIntent":
      acceptContextEngineTurnIntent({ ...command.input, database });
      return undefined;
    case "publishClosedTurn":
      return publishClosedContextEngineTurn({ ...command.input, database });
    case "discardIntent":
      return discardContextEngineTurnIntent({ ...command.input, database });
  }
  throw new Error("Unknown context-engine turn outbox command");
}
