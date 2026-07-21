/** Durable one-shot registrations for origin-bound sessions_send completion. */
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";

type DeferredCompletionTable = OpenClawStateKyselyDatabase["sessions_send_deferred_completions"];
type DeferredCompletionRow = Selectable<DeferredCompletionTable>;
type DeferredCompletionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "sessions_send_deferred_completions"
>;

export type SessionsSendDeferredRegistration = {
  targetRunId: string;
  targetSessionKey: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterOrigin: DeliveryContext;
  requestMessage: string;
  continuationRunId: string;
  createdAt: number;
  expiresAt: number;
};

function getDeferredCompletionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<DeferredCompletionDatabase>(db);
}

function parseRegistrationRow(
  row: DeferredCompletionRow | undefined,
): SessionsSendDeferredRegistration | undefined {
  if (!row) {
    return undefined;
  }
  let requesterOrigin: DeliveryContext | undefined;
  try {
    requesterOrigin = normalizeDeliveryContext(
      JSON.parse(row.requester_origin_json) as DeliveryContext,
    );
  } catch {
    return undefined;
  }
  if (!requesterOrigin?.channel || !requesterOrigin.to) {
    return undefined;
  }
  return {
    targetRunId: row.target_run_id,
    targetSessionKey: row.target_session_key,
    requesterSessionKey: row.requester_session_key,
    requesterSessionId: row.requester_session_id,
    requesterOrigin,
    requestMessage: row.request_message,
    continuationRunId: row.continuation_run_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Persist a deferred completion registration before its target run is dispatched. */
export function registerSessionsSendDeferredCompletion(
  registration: SessionsSendDeferredRegistration,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getDeferredCompletionKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("sessions_send_deferred_completions")
          .where("expires_at", "<=", registration.createdAt),
      );
      executeSqliteQuerySync(
        db,
        kysely.insertInto("sessions_send_deferred_completions").values({
          target_run_id: registration.targetRunId,
          target_session_key: registration.targetSessionKey,
          requester_session_key: registration.requesterSessionKey,
          requester_session_id: registration.requesterSessionId,
          requester_origin_json: JSON.stringify(registration.requesterOrigin),
          request_message: registration.requestMessage,
          continuation_run_id: registration.continuationRunId,
          state: "pending",
          created_at: registration.createdAt,
          expires_at: registration.expiresAt,
        }),
      );
    },
    options,
    { operationLabel: "sessions-send.deferred.register" },
  );
}

/** Cancel an unclaimed registration when target dispatch does not start. */
export function cancelSessionsSendDeferredCompletion(
  params: { targetRunId: string; error?: string; now?: number },
  options: OpenClawStateDatabaseOptions = {},
): void {
  const now = params.now ?? Date.now();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getDeferredCompletionKysely(db)
          .updateTable("sessions_send_deferred_completions")
          .set({ state: "cancelled", completed_at: now, last_error: params.error ?? null })
          .where("target_run_id", "=", params.targetRunId)
          .where("state", "=", "pending"),
      );
    },
    options,
    { operationLabel: "sessions-send.deferred.cancel" },
  );
}

/** Atomically claim a matching, unexpired registration for one continuation attempt. */
export function claimSessionsSendDeferredCompletion(
  params: {
    targetRunId: string;
    targetSessionKey: string;
    terminalOutcome: unknown;
    now?: number;
  },
  options: OpenClawStateDatabaseOptions = {},
): SessionsSendDeferredRegistration | undefined {
  const now = params.now ?? Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getDeferredCompletionKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("sessions_send_deferred_completions")
          .set({ state: "expired", completed_at: now })
          .where("target_run_id", "=", params.targetRunId)
          .where("state", "=", "pending")
          .where("expires_at", "<=", now),
      );
      const claim = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("sessions_send_deferred_completions")
          .set({
            state: "dispatching",
            claimed_at: now,
            terminal_outcome_json: JSON.stringify(params.terminalOutcome),
          })
          .where("target_run_id", "=", params.targetRunId)
          .where("target_session_key", "=", params.targetSessionKey)
          .where("state", "=", "pending")
          .where("expires_at", ">", now),
      );
      if (claim.numAffectedRows !== 1n) {
        return undefined;
      }
      return parseRegistrationRow(
        executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("sessions_send_deferred_completions")
            .selectAll()
            .where("target_run_id", "=", params.targetRunId),
        ),
      );
    },
    options,
    { operationLabel: "sessions-send.deferred.claim" },
  );
}

/** Record the sole continuation dispatch result without making it retryable. */
export function finishSessionsSendDeferredCompletion(
  params: { targetRunId: string; delivered: boolean; error?: string; now?: number },
  options: OpenClawStateDatabaseOptions = {},
): void {
  const now = params.now ?? Date.now();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getDeferredCompletionKysely(db)
          .updateTable("sessions_send_deferred_completions")
          .set({
            state: params.delivered ? "completed" : "cancelled",
            completed_at: now,
            last_error: params.error ?? null,
          })
          .where("target_run_id", "=", params.targetRunId)
          .where("state", "=", "dispatching"),
      );
    },
    options,
    { operationLabel: "sessions-send.deferred.finish" },
  );
}

/** List unexpired pending run IDs so completion lookup stays off ordinary run paths. */
export function listPendingSessionsSendDeferredRunIds(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): string[] {
  const now = options.now ?? Date.now();
  const { db } = openOpenClawStateDatabase(options);
  return executeSqliteQuerySync(
    db,
    getDeferredCompletionKysely(db)
      .selectFrom("sessions_send_deferred_completions")
      .select("target_run_id")
      .where("state", "=", "pending")
      .where("expires_at", ">", now),
  ).rows.map((row) => row.target_run_id);
}
