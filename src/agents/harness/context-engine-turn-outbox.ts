import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  readClosedTranscriptTurnInDatabase,
  type ClosedTranscriptTurnReadResult,
} from "../../config/sessions/session-accessor.transcript-range.js";
import type {
  TranscriptTurnAdmission,
  TranscriptTurnBoundary,
} from "../../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { ensureContextEngineTurnOutboxSchema } from "../../state/openclaw-agent-context-engine-turn-outbox-schema.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";

type ContextEngineTurnOutboxDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  "context_engine_turn_outbox"
>;

/** Outbox kernels need only the connection; workers pass their borrowed one. */
type ContextEngineTurnOutboxConnection = Pick<OpenClawAgentDatabase, "db">;

type PendingContextEngineTurn = Readonly<{
  advancement_key: string;
  payload_json: string;
  session_id: string;
}>;

/** Persist only resolved model facts, never live capabilities or credential-bearing config. */
export type ContextEngineTurnRuntimeContext = Readonly<{
  provider?: string;
  modelId?: string;
  modelContextWindow?: number;
  tokenBudget?: number;
}>;

type AdmittedContextEngineTurnOutboxPayload = Readonly<{
  admission: TranscriptTurnAdmission;
  isHeartbeat: boolean;
  state: "admitted";
}>;

type AcceptedContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  isHeartbeat: boolean;
  state: "accepted";
  runtimeContext?: ContextEngineTurnRuntimeContext;
}>;

type ReadyContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  isHeartbeat: boolean;
  messages: AgentMessage[];
  state: "ready";
  runtimeContext?: ContextEngineTurnRuntimeContext;
}>;

type ContextEngineTurnReadFailureKind = Exclude<
  ClosedTranscriptTurnReadResult,
  { kind: "ok" }
>["kind"];

type BlockedContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  failure: Exclude<ContextEngineTurnReadFailureKind, "projection-unavailable">;
  isHeartbeat: boolean;
  state: "blocked";
}>;

type ContextEngineTurnOutboxPayload =
  | AdmittedContextEngineTurnOutboxPayload
  | AcceptedContextEngineTurnOutboxPayload
  | BlockedContextEngineTurnOutboxPayload
  | ReadyContextEngineTurnOutboxPayload;

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

export function isRetryableContextEngineTurnReadFailure(
  kind: ContextEngineTurnReadFailureKind,
): kind is "projection-unavailable" {
  return kind === "projection-unavailable";
}

function outboxDb(database: ContextEngineTurnOutboxConnection) {
  ensureContextEngineTurnOutboxSchema(database.db);
  return getNodeSqliteKysely<ContextEngineTurnOutboxDatabase>(database.db);
}

function assertMatchingOutboxOwner(
  existing: { engine_id: string; owner_plugin_id: string | null },
  params: { engineId: string; ownerPluginId?: string },
  advancementKey: string,
): void {
  if (
    existing.engine_id !== params.engineId ||
    existing.owner_plugin_id !== (params.ownerPluginId ?? null)
  ) {
    throw new Error(`context-engine advancement key collision: ${advancementKey}`);
  }
}

function writeContextEngineTurnOutboxPayload(params: {
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  ownerPluginId?: string;
  payload: ContextEngineTurnOutboxPayload;
}): void {
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
    const existingPayload = JSON.parse(existing.payload_json) as ContextEngineTurnOutboxPayload;
    const transitionMatches =
      (params.payload.state === "accepted" &&
        existingPayload.state === "admitted" &&
        existingPayload.admission.entryId === admission.entryId) ||
      (params.payload.state === "blocked" &&
        existingPayload.state === "accepted" &&
        existingPayload.boundary.admission.entryId === admission.entryId &&
        existingPayload.boundary.terminal.entryId === params.payload.boundary.terminal.entryId) ||
      (params.payload.state === "ready" &&
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

export function enqueueContextEngineTurnIntent(params: {
  admission: TranscriptTurnAdmission;
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  isHeartbeat: boolean;
  ownerPluginId?: string;
}): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: {
      admission: params.admission,
      isHeartbeat: params.isHeartbeat,
      state: "admitted",
    },
  });
}

export function acceptContextEngineTurnIntent(params: {
  boundary: TranscriptTurnBoundary;
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  isHeartbeat: boolean;
  ownerPluginId?: string;
  runtimeContext?: ContextEngineTurnRuntimeContext;
}): void {
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

function blockContextEngineTurnIntent(params: {
  boundary: TranscriptTurnBoundary;
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  failure: BlockedContextEngineTurnOutboxPayload["failure"];
  isHeartbeat: boolean;
  ownerPluginId?: string;
}): void {
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

function discardContextEngineTurnIntent(params: {
  admission: TranscriptTurnAdmission;
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  ownerPluginId?: string;
}): void {
  const db = outboxDb(params.database);
  executeSqliteQuerySync(
    params.database.db,
    db
      .deleteFrom("context_engine_turn_outbox")
      .where("advancement_key", "=", params.admission.logicalTurnId)
      .where("engine_id", "=", params.engineId)
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null),
  );
}

/**
 * Reads an accepted turn's bounded range and publishes it as ready or blocked.
 * The acceptance commits first in its own transaction, so a failed read or
 * publication leaves the turn accepted and the next recovery advances it.
 */
function publishClosedContextEngineTurn(params: {
  boundary: TranscriptTurnBoundary;
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  isHeartbeat: boolean;
  maxBytes: number;
  maxEvents: number;
  ownerPluginId?: string;
  runtimeContext?: ContextEngineTurnRuntimeContext;
}): ClosedTranscriptTurnReadResult["kind"] {
  // Recovery may already have advanced or completed this turn in the gap after
  // acceptance; only a still-accepted row is published, so it cannot reappear.
  const existing = executeSqliteQueryTakeFirstSync(
    params.database.db,
    outboxDb(params.database)
      .selectFrom("context_engine_turn_outbox")
      .select("payload_json")
      .where("advancement_key", "=", params.boundary.admission.logicalTurnId),
  );
  if (!existing) {
    return "ok";
  }
  // SAFETY: payload_json is written only by writeContextEngineTurnOutboxPayload from this union.
  const existingPayload = JSON.parse(existing.payload_json) as ContextEngineTurnOutboxPayload;
  if (existingPayload.state !== "accepted") {
    return "ok";
  }
  const closedTurn = readClosedTranscriptTurnInDatabase(params.database.db, {
    boundary: params.boundary,
    maxEvents: params.maxEvents,
    maxBytes: params.maxBytes,
  });
  if (closedTurn.kind !== "ok") {
    if (!isRetryableContextEngineTurnReadFailure(closedTurn.kind)) {
      blockContextEngineTurnIntent({ ...params, failure: closedTurn.kind });
    }
    return closedTurn.kind;
  }
  enqueueContextEngineTurnCommit({
    database: params.database,
    engineId: params.engineId,
    ownerPluginId: params.ownerPluginId,
    payload: {
      boundary: params.boundary,
      isHeartbeat: params.isHeartbeat,
      messages: closedTurn.messages,
      runtimeContext: params.runtimeContext,
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
}): void {
  const db = outboxDb(params.database);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["advancement_key", "payload_json"])
      .where("engine_id", "=", params.engineId)
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null)
      .where("session_id", "=", params.sessionId)
      .orderBy(outboxEnqueueSequence(), "asc"),
  ).rows;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
    if (payload.state === "ready") {
      continue;
    }
    if (payload.state === "blocked") {
      params.warn(
        `[context-engine] durable turn advancement is blocked: ${row.advancement_key}: transcript range is ${payload.failure}`,
      );
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
      continue;
    }
    const closedTurn = readClosedTranscriptTurnInDatabase(params.database.db, {
      boundary: payload.boundary,
      maxEvents: RECOVERED_TURN_MAX_EVENTS,
      maxBytes: RECOVERED_TURN_MAX_BYTES,
    });
    if (closedTurn.kind !== "ok") {
      if (isRetryableContextEngineTurnReadFailure(closedTurn.kind)) {
        params.warn(
          `[context-engine] durable turn recovery remains queued: ${row.advancement_key}: transcript range is ${closedTurn.kind}`,
        );
        continue;
      }
      params.warn(
        `[context-engine] blocked unrecoverable turn advancement: ${row.advancement_key}: transcript range is ${closedTurn.kind}`,
      );
      blockContextEngineTurnIntent({
        boundary: payload.boundary,
        database: params.database,
        engineId: params.engineId,
        failure: closedTurn.kind,
        isHeartbeat: payload.isHeartbeat,
        ownerPluginId: params.ownerPluginId,
      });
      continue;
    }
    enqueueContextEngineTurnCommit({
      database: params.database,
      engineId: params.engineId,
      ownerPluginId: params.ownerPluginId,
      payload: {
        boundary: payload.boundary,
        isHeartbeat: payload.isHeartbeat,
        messages: closedTurn.messages,
        runtimeContext: payload.runtimeContext,
      },
    });
  }
}

type ContextEngineTurnOutboxFilter = Readonly<{
  engineId: string;
  ownerPluginId?: string;
}>;

/** Durable outbox rows the drain reads and settles through the agent database worker. */
export type ContextEngineTurnOutboxStore = Readonly<{
  listPendingSessions(
    filter: ContextEngineTurnOutboxFilter & { sessionId?: string; limit: number },
  ): Promise<string[]>;
  readNextPending(
    filter: ContextEngineTurnOutboxFilter & { sessionId: string },
  ): Promise<PendingContextEngineTurn | undefined>;
  complete(advancementKey: string): Promise<void>;
  recordFailure(advancementKey: string, message: string, attemptedAt: number): Promise<void>;
  hasPending(filter: ContextEngineTurnOutboxFilter & { sessionId?: string }): Promise<boolean>;
}>;

/** Lists sessions with advanceable rows, oldest enqueue first. */
function listPendingContextEngineTurnSessions(
  database: ContextEngineTurnOutboxConnection,
  filter: ContextEngineTurnOutboxFilter & { sessionId?: string; limit: number },
): string[] {
  const db = outboxDb(database);
  let query = db
    .selectFrom("context_engine_turn_outbox")
    .select("session_id")
    // SQLite rowid preserves enqueue order among surviving pending rows.
    // Use it instead of wall-clock timestamps, which can collide.
    .select(oldestOutboxEnqueueSequence().as("oldest_enqueue_sequence"))
    .where("engine_id", "=", filter.engineId)
    .where("owner_plugin_id", filter.ownerPluginId ? "=" : "is", filter.ownerPluginId ?? null)
    .where(outboxPayloadRequiresAdvancement());
  if (filter.sessionId) {
    query = query.where("session_id", "=", filter.sessionId);
  }
  return executeSqliteQuerySync(
    database.db,
    query.groupBy("session_id").orderBy("oldest_enqueue_sequence", "asc").limit(filter.limit),
  ).rows.map(({ session_id }) => session_id);
}

/** Reads one session's oldest advanceable row. */
function readNextPendingContextEngineTurn(
  database: ContextEngineTurnOutboxConnection,
  filter: ContextEngineTurnOutboxFilter & { sessionId: string },
): PendingContextEngineTurn | undefined {
  return executeSqliteQueryTakeFirstSync(
    database.db,
    outboxDb(database)
      .selectFrom("context_engine_turn_outbox")
      .select(["advancement_key", "payload_json", "session_id"])
      .where("engine_id", "=", filter.engineId)
      .where("owner_plugin_id", filter.ownerPluginId ? "=" : "is", filter.ownerPluginId ?? null)
      .where("session_id", "=", filter.sessionId)
      .where(outboxPayloadRequiresAdvancement())
      .orderBy(outboxEnqueueSequence(), "asc")
      .limit(1),
  );
}

/** Removes a row after its engine acknowledged the commit. */
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

/** Keeps a row queued and records its latest failed attempt. */
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

/** Reports whether any advanceable row remains for the filter. */
function hasPendingContextEngineTurn(
  database: ContextEngineTurnOutboxConnection,
  filter: ContextEngineTurnOutboxFilter & { sessionId?: string },
): boolean {
  let query = outboxDb(database)
    .selectFrom("context_engine_turn_outbox")
    .select("advancement_key")
    .where("engine_id", "=", filter.engineId)
    .where("owner_plugin_id", filter.ownerPluginId ? "=" : "is", filter.ownerPluginId ?? null)
    .where(outboxPayloadRequiresAdvancement());
  if (filter.sessionId) {
    query = query.where("session_id", "=", filter.sessionId);
  }
  return executeSqliteQueryTakeFirstSync(database.db, query.limit(1)) !== undefined;
}

/**
 * Recovers a session's outbox before a run and, when nothing remains to
 * advance, records the known admission in the same transaction. The common
 * turn start therefore needs one database round trip.
 */
function prepareContextEngineTurnRun(params: {
  admission?: TranscriptTurnAdmission;
  database: ContextEngineTurnOutboxConnection;
  engineId: string;
  isHeartbeat: boolean;
  ownerPluginId?: string;
  sessionId: string;
}): { warnings: string[]; pending: boolean; admitted: boolean } {
  const warnings: string[] = [];
  recoverContextEngineTurnOutbox({ ...params, warn: (message) => warnings.push(message) });
  const pending = hasPendingContextEngineTurn(params.database, params);
  if (pending || !params.admission) {
    return { warnings, pending, admitted: false };
  }
  enqueueContextEngineTurnIntent({ ...params, admission: params.admission });
  return { warnings, pending, admitted: true };
}

export async function drainContextEngineTurnOutbox(params: {
  store: ContextEngineTurnOutboxStore;
  engine: ContextEngine;
  engineId: string;
  ownerPluginId?: string;
  sessionId?: string;
  limit?: number;
  /** Observe acknowledged turns without changing durable advancement on observer failure. */
  onCommitted?: (turn: Parameters<NonNullable<ContextEngine["commitTurn"]>>[0]) => void;
  warn: (message: string) => void;
}): Promise<{ pending: boolean }> {
  const { store } = params;
  const filter = { engineId: params.engineId, ownerPluginId: params.ownerPluginId };
  if (typeof params.engine.commitTurn !== "function") {
    return { pending: false };
  }
  let remaining = Math.max(0, params.limit ?? 16);
  if (remaining === 0) {
    return { pending: await store.hasPending({ ...filter, sessionId: params.sessionId }) };
  }
  let activeSessionIds = await store.listPendingSessions({
    ...filter,
    sessionId: params.sessionId,
    limit: remaining,
  });
  while (remaining > 0 && activeSessionIds.length > 0) {
    const continuingSessionIds: string[] = [];
    for (const sessionId of activeSessionIds) {
      if (remaining === 0) {
        break;
      }
      const row = await store.readNextPending({ ...filter, sessionId });
      if (!row) {
        continue;
      }
      remaining -= 1;
      if (await commitPendingContextEngineTurn({ ...params, store, row })) {
        continuingSessionIds.push(sessionId);
      }
    }
    activeSessionIds = continuingSessionIds;
  }
  return { pending: await store.hasPending({ ...filter, sessionId: params.sessionId }) };
}

async function commitPendingContextEngineTurn(params: {
  engine: ContextEngine;
  onCommitted?: (turn: Parameters<NonNullable<ContextEngine["commitTurn"]>>[0]) => void;
  row: PendingContextEngineTurn;
  store: ContextEngineTurnOutboxStore;
  warn: (message: string) => void;
}): Promise<boolean> {
  const { row } = params;
  try {
    const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
    if (payload.state !== "ready") {
      return false;
    }
    const commonParams = {
      advancementKey: row.advancement_key,
      admission: payload.boundary.admission,
      terminal: payload.boundary.terminal,
      messages: payload.messages,
      sessionId: payload.boundary.admission.sessionId,
      sessionKey: payload.boundary.admission.sessionKey,
      sessionTarget: {
        agentId: payload.boundary.admission.agentId,
        sessionId: payload.boundary.admission.sessionId,
        sessionKey: payload.boundary.admission.sessionKey,
        storePath: payload.boundary.admission.storePath,
      },
      isHeartbeat: payload.isHeartbeat,
      ...(payload.runtimeContext ? { runtimeContext: payload.runtimeContext } : {}),
    };
    const result = await params.engine.commitTurn?.(commonParams);
    if (!result) {
      throw new Error("context engine does not implement commitTurn");
    }
    if (result.status !== "committed" && result.status !== "duplicate") {
      throw new Error(`invalid commitTurn result status: ${String(result.status)}`);
    }
    await params.store.complete(row.advancement_key);
    // Notification is best effort after acknowledgment; its failure must never requeue a commit.
    try {
      params.onCommitted?.(commonParams);
    } catch (error) {
      params.warn(
        `[context-engine] committed turn notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.store.recordFailure(row.advancement_key, message, Date.now());
    params.warn(
      `[context-engine] durable turn advancement remains queued: ${row.advancement_key}: ${message}`,
    );
    return false;
  }
}

type OutboxOwner = { engineId: string; ownerPluginId?: string };

export type ContextEngineTurnOutboxWorkerOperations = {
  prepareRun: {
    input: OutboxOwner & {
      admission?: TranscriptTurnAdmission;
      isHeartbeat: boolean;
      sessionId: string;
    };
    output: { warnings: string[]; pending: boolean; admitted: boolean };
  };
  listPendingSessions: {
    input: OutboxOwner & { sessionId?: string; limit: number };
    output: string[];
  };
  readNextPending: {
    input: OutboxOwner & { sessionId: string };
    output: PendingContextEngineTurn | undefined;
  };
  complete: { input: { advancementKey: string }; output: undefined };
  recordFailure: {
    input: { advancementKey: string; message: string; attemptedAt: number };
    output: undefined;
  };
  hasPending: { input: OutboxOwner & { sessionId?: string }; output: boolean };
  enqueueIntent: {
    input: OutboxOwner & { admission: TranscriptTurnAdmission; isHeartbeat: boolean };
    output: undefined;
  };
  acceptIntent: {
    input: OutboxOwner & {
      boundary: TranscriptTurnBoundary;
      isHeartbeat: boolean;
      runtimeContext?: ContextEngineTurnRuntimeContext;
    };
    output: undefined;
  };
  publishClosedTurn: {
    input: OutboxOwner & {
      boundary: TranscriptTurnBoundary;
      isHeartbeat: boolean;
      maxBytes: number;
      maxEvents: number;
      runtimeContext?: ContextEngineTurnRuntimeContext;
    };
    output: ClosedTranscriptTurnReadResult["kind"];
  };
  discardIntent: {
    input: OutboxOwner & { admission: TranscriptTurnAdmission };
    output: undefined;
  };
};

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
      discardContextEngineTurnIntent({ ...command.input, database });
      return undefined;
  }
  throw new Error("Unknown context-engine turn outbox command");
}
