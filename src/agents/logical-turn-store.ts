import {
  deferOpenClawAgentPostCommitPublication,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import { ensureOpenClawAgentLogicalTurnSchema } from "../state/openclaw-agent-logical-turn-schema.js";

export type LogicalTurnIngressKind = "chat" | "telegram";

export type LogicalTurnAcceptance = {
  logicalTurnId: string;
  ingressKind: LogicalTurnIngressKind;
  ingressKey: string;
  sessionId: string;
  sessionKey: string;
  userEventId: string;
  now?: number;
};

export type LogicalTurnAttemptClaim =
  | { claimed: true; attemptEpoch: number; leaseExpiresAt: number }
  | { claimed: false; reason: "active-attempt" | "missing-turn" | "terminal-turn" };

export type LogicalTurnRecord = {
  logicalTurnId: string;
  sessionId: string;
  sessionKey: string;
  ingressKind: LogicalTurnIngressKind;
  ingressKey: string;
  userEventId: string;
  state: "accepted" | "running" | "terminal";
  currentAttemptEpoch: number;
  createdAt: number;
  updatedAt: number;
};

const ensuredDatabases = new WeakSet<OpenClawAgentDatabase["db"]>();

/** Additive v14 feature surface, installed lazily on first logical-turn use. */
export function ensureLogicalTurnSchema(database: OpenClawAgentDatabase): void {
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  ensureOpenClawAgentLogicalTurnSchema(database.db);
  if (
    !deferOpenClawAgentPostCommitPublication(database, () => {
      ensuredDatabases.add(database.db);
    })
  ) {
    ensuredDatabases.add(database.db);
  }
}

function readLogicalTurnFromDatabase(
  database: OpenClawAgentDatabase,
  logicalTurnId: string,
): LogicalTurnRecord | undefined {
  const row =
    database.db /* sqlite-allow-raw: synchronous logical-turn lookup inside the agent DB transaction owner. */
      .prepare(
        `SELECT logical_turn_id, session_id, session_key, ingress_kind, ingress_key,
              user_event_id, state, current_attempt_epoch, created_at, updated_at
         FROM logical_turns
        WHERE logical_turn_id = ?`,
      )
      .get(logicalTurnId) as
      | {
          logical_turn_id: string;
          session_id: string;
          session_key: string;
          ingress_kind: LogicalTurnIngressKind;
          ingress_key: string;
          user_event_id: string;
          state: LogicalTurnRecord["state"];
          current_attempt_epoch: number;
          created_at: number;
          updated_at: number;
        }
      | undefined;
  return row
    ? {
        logicalTurnId: row.logical_turn_id,
        sessionId: row.session_id,
        sessionKey: row.session_key,
        ingressKind: row.ingress_kind,
        ingressKey: row.ingress_key,
        userEventId: row.user_event_id,
        state: row.state,
        currentAttemptEpoch: row.current_attempt_epoch,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : undefined;
}

/**
 * Accept one user turn in the caller's transcript transaction.
 * A repeated ingress identity must resolve to the exact same transcript event.
 */
export function acceptLogicalTurnInTransaction(
  database: OpenClawAgentDatabase,
  params: LogicalTurnAcceptance,
): { accepted: true; created: boolean } {
  ensureLogicalTurnSchema(database);
  const now = params.now ?? Date.now();
  const inserted =
    database.db /* sqlite-allow-raw: idempotent logical-turn acceptance is one bounded transaction-local write. */
      .prepare(
        `INSERT OR IGNORE INTO logical_turns (
         logical_turn_id, session_id, session_key, ingress_kind, ingress_key,
         user_event_id, state, current_attempt_epoch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?)`,
      )
      .run(
        params.logicalTurnId,
        params.sessionId,
        params.sessionKey,
        params.ingressKind,
        params.ingressKey,
        params.userEventId,
        now,
        now,
      );
  const persisted = readLogicalTurnFromDatabase(database, params.logicalTurnId);
  if (
    !persisted ||
    persisted.ingressKind !== params.ingressKind ||
    persisted.ingressKey !== params.ingressKey ||
    persisted.sessionId !== params.sessionId ||
    persisted.sessionKey !== params.sessionKey ||
    persisted.userEventId !== params.userEventId
  ) {
    throw new Error(`logical turn identity conflict for ${params.logicalTurnId}`);
  }
  return { accepted: true, created: inserted.changes === 1 };
}

export function readLogicalTurn(
  options: OpenClawAgentDatabaseOptions,
  logicalTurnId: string,
): LogicalTurnRecord | undefined {
  const database = openOpenClawAgentDatabase(options);
  ensureLogicalTurnSchema(database);
  return readLogicalTurnFromDatabase(database, logicalTurnId);
}

export function claimLogicalTurnAttempt(
  options: OpenClawAgentDatabaseOptions,
  params: {
    logicalTurnId: string;
    ownerId: string;
    leaseDurationMs: number;
    now?: number;
  },
): LogicalTurnAttemptClaim {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const now = params.now ?? Date.now();
      database.db /* sqlite-allow-raw: expire one stale active attempt before the claim CAS. */
        .prepare(
          `UPDATE logical_turn_attempts
              SET state = 'abandoned', finished_at = ?
            WHERE logical_turn_id = ? AND state = 'active' AND lease_expires_at <= ?`,
        )
        .run(now, params.logicalTurnId, now);
      const turn = readLogicalTurnFromDatabase(database, params.logicalTurnId);
      if (!turn) {
        return { claimed: false, reason: "missing-turn" };
      }
      if (turn.state === "terminal") {
        return { claimed: false, reason: "terminal-turn" };
      }
      const active = database.db /* sqlite-allow-raw: transaction-local active-attempt fence. */
        .prepare(
          "SELECT 1 AS active FROM logical_turn_attempts WHERE logical_turn_id = ? AND state = 'active'",
        )
        .get(params.logicalTurnId);
      if (active) {
        return { claimed: false, reason: "active-attempt" };
      }
      const attemptEpoch = turn.currentAttemptEpoch + 1;
      const leaseExpiresAt = now + params.leaseDurationMs;
      const advanced =
        database.db /* sqlite-allow-raw: epoch compare-and-swap for one logical turn. */
          .prepare(
            `UPDATE logical_turns
              SET state = 'running', current_attempt_epoch = ?, updated_at = ?
            WHERE logical_turn_id = ? AND current_attempt_epoch = ? AND state != 'terminal'`,
          )
          .run(attemptEpoch, now, params.logicalTurnId, turn.currentAttemptEpoch);
      if (advanced.changes !== 1) {
        return { claimed: false, reason: "active-attempt" };
      }
      database.db /* sqlite-allow-raw: insert the attempt after the epoch CAS in the same transaction. */
        .prepare(
          `INSERT INTO logical_turn_attempts (
             logical_turn_id, attempt_epoch, owner_id, state,
             lease_expires_at, acquired_at, finished_at
           ) VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
        )
        .run(params.logicalTurnId, attemptEpoch, params.ownerId, leaseExpiresAt, now);
      return { claimed: true, attemptEpoch, leaseExpiresAt };
    },
    options,
    { operationLabel: "logical-turn-attempt-claim" },
  );
}

export function finishLogicalTurnAttempt(
  options: OpenClawAgentDatabaseOptions,
  params: {
    logicalTurnId: string;
    attemptEpoch: number;
    ownerId: string;
    outcome: "succeeded" | "failed" | "abandoned";
    terminal: boolean;
    now?: number;
  },
): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const now = params.now ?? Date.now();
      const finished =
        database.db /* sqlite-allow-raw: owner-and-epoch compare-and-swap settlement. */
          .prepare(
            `UPDATE logical_turn_attempts
              SET state = ?, finished_at = ?
            WHERE logical_turn_id = ? AND attempt_epoch = ? AND owner_id = ? AND state = 'active'`,
          )
          .run(params.outcome, now, params.logicalTurnId, params.attemptEpoch, params.ownerId);
      if (finished.changes !== 1) {
        return false;
      }
      database.db /* sqlite-allow-raw: transition the parent turn after owned attempt settlement. */
        .prepare(
          `UPDATE logical_turns
              SET state = ?, updated_at = ?
            WHERE logical_turn_id = ? AND current_attempt_epoch = ?`,
        )
        .run(
          params.terminal ? "terminal" : "accepted",
          now,
          params.logicalTurnId,
          params.attemptEpoch,
        );
      return true;
    },
    options,
    { operationLabel: "logical-turn-attempt-finish" },
  );
}

export function renewLogicalTurnAttempt(
  options: OpenClawAgentDatabaseOptions,
  params: {
    logicalTurnId: string;
    attemptEpoch: number;
    ownerId: string;
    leaseDurationMs: number;
    now?: number;
  },
): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const now = params.now ?? Date.now();
      const renewed =
        database.db /* sqlite-allow-raw: owner-and-epoch compare-and-swap lease renewal. */
          .prepare(
            `UPDATE logical_turn_attempts
              SET lease_expires_at = ?
            WHERE logical_turn_id = ? AND attempt_epoch = ? AND owner_id = ?
              AND state = 'active' AND lease_expires_at > ?`,
          )
          .run(
            now + params.leaseDurationMs,
            params.logicalTurnId,
            params.attemptEpoch,
            params.ownerId,
            now,
          );
      return renewed.changes === 1;
    },
    options,
    { operationLabel: "logical-turn-attempt-renew" },
  );
}
