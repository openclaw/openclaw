import { createHash } from "node:crypto";
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
  | {
      claimed: false;
      reason: "active-attempt" | "effect-unknown" | "missing-turn" | "terminal-turn";
    };

export type LogicalTurnEffectState =
  | "planned"
  | "dispatched"
  | "committed"
  | "unknown"
  | "reconciled";

export type LogicalTurnEffectRecord = {
  effectId: string;
  logicalTurnId: string;
  attemptEpoch: number;
  assistantCheckpointId: string;
  toolCallId: string;
  toolName: string;
  replayClass: "replay_safe" | "idempotent" | "external";
  downstreamIdempotencyKey?: string;
  state: LogicalTurnEffectState;
  resultJson?: string;
  resultHash?: string;
};

export type LogicalTurnRecord = {
  logicalTurnId: string;
  sessionId: string;
  sessionKey: string;
  ingressKind: LogicalTurnIngressKind;
  ingressKey: string;
  userEventId: string;
  state: "accepted" | "running" | "terminal";
  currentAttemptEpoch: number;
  deliveryRef?: string;
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
              user_event_id, state, current_attempt_epoch, delivery_ref, created_at, updated_at
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
          delivery_ref: string | null;
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
        ...(row.delivery_ref ? { deliveryRef: row.delivery_ref } : {}),
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

/** Bind one global durable-delivery authority to its owning per-agent turn. */
export function recordLogicalTurnDeliveryRef(
  options: OpenClawAgentDatabaseOptions,
  params: { logicalTurnId: string; deliveryRef: string; now?: number },
): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const now = params.now ?? Date.now();
      const updated =
        database.db /* sqlite-allow-raw: one stable global queue reference, never a second acknowledgement authority. */
          .prepare(
            `UPDATE logical_turns
              SET delivery_ref = ?, updated_at = ?
            WHERE logical_turn_id = ? AND (delivery_ref IS NULL OR delivery_ref = ?)`,
          )
          .run(params.deliveryRef, now, params.logicalTurnId, params.deliveryRef);
      return updated.changes === 1;
    },
    options,
    { operationLabel: "logical-turn-delivery-ref" },
  );
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
      database.db /* sqlite-allow-raw: any old process that crossed dispatch without committing has an ambiguous external outcome. */
        .prepare(
          `UPDATE logical_turn_effects
              SET effect_state = 'unknown'
            WHERE logical_turn_id = ? AND effect_state = 'dispatched'
              AND NOT EXISTS (
                SELECT 1
                  FROM logical_turn_attempts AS active_attempt
                 WHERE active_attempt.logical_turn_id = logical_turn_effects.logical_turn_id
                   AND active_attempt.attempt_epoch = logical_turn_effects.attempt_epoch
                   AND active_attempt.state = 'active'
              )`,
        )
        .run(params.logicalTurnId);
      const turn = readLogicalTurnFromDatabase(database, params.logicalTurnId);
      if (!turn) {
        return { claimed: false, reason: "missing-turn" };
      }
      if (turn.state === "terminal") {
        return { claimed: false, reason: "terminal-turn" };
      }
      const unknownEffect =
        database.db /* sqlite-allow-raw: unresolved external effects pause this same logical request. */
          .prepare(
            `SELECT 1 AS present
             FROM logical_turn_effects
            WHERE logical_turn_id = ? AND effect_state = 'unknown'
            LIMIT 1`,
          )
          .get(params.logicalTurnId);
      if (unknownEffect) {
        return { claimed: false, reason: "effect-unknown" };
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

/** Stable effect identity excludes attempt epochs and regenerated arguments. */
export function buildLogicalTurnEffectId(params: {
  logicalTurnId: string;
  assistantCheckpointId: string;
  toolCallId: string;
}): string {
  return `effect:v1:${createHash("sha256")
    .update(params.logicalTurnId)
    .update("\0")
    .update(params.assistantCheckpointId)
    .update("\0")
    .update(params.toolCallId)
    .digest("hex")}`;
}

function readLogicalTurnEffectFromDatabase(
  database: OpenClawAgentDatabase,
  effectId: string,
): LogicalTurnEffectRecord | undefined {
  const row = database.db /* sqlite-allow-raw: bounded effect lookup in its per-agent owner. */
    .prepare(
      `SELECT effect_id, logical_turn_id, attempt_epoch, assistant_checkpoint_id,
              tool_call_id, tool_name, replay_class, downstream_idempotency_key,
              effect_state, result_json, result_hash
         FROM logical_turn_effects
        WHERE effect_id = ?`,
    )
    .get(effectId) as
    | {
        effect_id: string;
        logical_turn_id: string;
        attempt_epoch: number;
        assistant_checkpoint_id: string | null;
        tool_call_id: string | null;
        tool_name: string | null;
        replay_class: LogicalTurnEffectRecord["replayClass"] | null;
        downstream_idempotency_key: string | null;
        effect_state: LogicalTurnEffectState;
        result_json: string | null;
        result_hash: string | null;
      }
    | undefined;
  if (!row?.assistant_checkpoint_id || !row.tool_call_id || !row.tool_name || !row.replay_class) {
    return undefined;
  }
  return {
    effectId: row.effect_id,
    logicalTurnId: row.logical_turn_id,
    attemptEpoch: row.attempt_epoch,
    assistantCheckpointId: row.assistant_checkpoint_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    replayClass: row.replay_class,
    ...(row.downstream_idempotency_key
      ? { downstreamIdempotencyKey: row.downstream_idempotency_key }
      : {}),
    state: row.effect_state,
    ...(row.result_json ? { resultJson: row.result_json } : {}),
    ...(row.result_hash ? { resultHash: row.result_hash } : {}),
  };
}

/** Plan one tool effect only after its assistant tool-call identity is durable. */
export function planLogicalTurnToolEffect(
  options: OpenClawAgentDatabaseOptions,
  params: {
    logicalTurnId: string;
    attemptEpoch: number;
    assistantCheckpointId: string;
    toolCallId: string;
    toolName: string;
    replayClass: LogicalTurnEffectRecord["replayClass"];
    downstreamIdempotencyKey?: string;
    now?: number;
  },
): LogicalTurnEffectRecord {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const effectId = buildLogicalTurnEffectId(params);
      const now = params.now ?? Date.now();
      const activeAttempt =
        database.db /* sqlite-allow-raw: tool effects require the current active attempt lease. */
          .prepare(
            `SELECT 1 AS present
             FROM logical_turn_attempts
            WHERE logical_turn_id = ? AND attempt_epoch = ? AND state = 'active'`,
          )
          .get(params.logicalTurnId, params.attemptEpoch);
      if (!activeAttempt) {
        throw new Error("logical turn tool effect has no active attempt");
      }
      database.db /* sqlite-allow-raw: stable insert makes crash-boundary planning idempotent. */
        .prepare(
          `INSERT OR IGNORE INTO logical_turn_effects (
             effect_id, logical_turn_id, attempt_epoch, effect_kind, idempotency_key, state,
             assistant_checkpoint_id, tool_call_id, tool_name, replay_class,
             downstream_idempotency_key, effect_state, created_at
           ) VALUES (?, ?, ?, 'tool', ?, 'planned', ?, ?, ?, ?, ?, 'planned', ?)`,
        )
        .run(
          effectId,
          params.logicalTurnId,
          params.attemptEpoch,
          effectId,
          params.assistantCheckpointId,
          params.toolCallId,
          params.toolName,
          params.replayClass,
          params.downstreamIdempotencyKey ?? null,
          now,
        );
      const effect = readLogicalTurnEffectFromDatabase(database, effectId);
      if (
        !effect ||
        effect.logicalTurnId !== params.logicalTurnId ||
        effect.assistantCheckpointId !== params.assistantCheckpointId ||
        effect.toolCallId !== params.toolCallId ||
        effect.toolName !== params.toolName
      ) {
        throw new Error(`logical turn effect identity conflict for ${effectId}`);
      }
      return effect;
    },
    options,
    { operationLabel: "logical-turn-effect-plan" },
  );
}

/** Cross the write-ahead dispatch boundary or return the durable prior state. */
export function dispatchLogicalTurnToolEffect(
  options: OpenClawAgentDatabaseOptions,
  params: { effectId: string; now?: number },
): { effect: LogicalTurnEffectRecord; claimed: boolean } {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const now = params.now ?? Date.now();
      const dispatched =
        database.db /* sqlite-allow-raw: write-ahead dispatch CAS precedes external tool I/O. */
          .prepare(
            `UPDATE logical_turn_effects
              SET effect_state = 'dispatched', dispatched_at = ?
            WHERE effect_id = ? AND effect_state = 'planned'`,
          )
          .run(now, params.effectId);
      const effect = readLogicalTurnEffectFromDatabase(database, params.effectId);
      if (!effect) {
        throw new Error(`logical turn effect is missing: ${params.effectId}`);
      }
      return { effect, claimed: dispatched.changes === 1 };
    },
    options,
    { operationLabel: "logical-turn-effect-dispatch" },
  );
}

/**
 * Commit the normalized result in the protected per-agent database so replay
 * returns the transcript-equivalent payload exactly. Tool arguments are not
 * copied here; global incident and operator projections remain content-free.
 */
export function commitLogicalTurnToolEffect(
  options: OpenClawAgentDatabaseOptions,
  params: { effectId: string; resultJson: string; resultHash: string; now?: number },
): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const now = params.now ?? Date.now();
      const committed =
        database.db /* sqlite-allow-raw: protected per-agent effect CAS stores transcript-equivalent result JSON, never copied tool arguments. */
          .prepare(
            `UPDATE logical_turn_effects
              SET effect_state = 'committed', state = 'committed',
                  result_json = ?, result_hash = ?, committed_at = ?
            WHERE effect_id = ? AND effect_state = 'dispatched'`,
          )
          .run(params.resultJson, params.resultHash, now, params.effectId);
      if (committed.changes === 1) {
        return true;
      }
      const existing = readLogicalTurnEffectFromDatabase(database, params.effectId);
      return (
        existing?.state === "committed" &&
        existing.resultJson === params.resultJson &&
        existing.resultHash === params.resultHash
      );
    },
    options,
    { operationLabel: "logical-turn-effect-commit" },
  );
}

/** Fail closed after an external dispatch whose downstream outcome is ambiguous. */
export function markLogicalTurnToolEffectUnknown(
  options: OpenClawAgentDatabaseOptions,
  params: { effectId: string },
): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const updated =
        database.db /* sqlite-allow-raw: dispatched external effects become operator-reconciled unknowns. */
          .prepare(
            `UPDATE logical_turn_effects
              SET effect_state = 'unknown'
            WHERE effect_id = ? AND effect_state = 'dispatched'
              AND replay_class IN ('external', 'idempotent')`,
          )
          .run(params.effectId);
      return updated.changes === 1;
    },
    options,
    { operationLabel: "logical-turn-effect-unknown" },
  );
}

/** Reset only audited replay-safe failures that did not return a tool result. */
export function resetLogicalTurnReplaySafeToolEffect(
  options: OpenClawAgentDatabaseOptions,
  params: { effectId: string },
): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const updated =
        database.db /* sqlite-allow-raw: replay-safe class is the sole automatic dispatch reset path. */
          .prepare(
            `UPDATE logical_turn_effects
              SET effect_state = 'planned', dispatched_at = NULL
            WHERE effect_id = ? AND effect_state = 'dispatched' AND replay_class = 'replay_safe'`,
          )
          .run(params.effectId);
      return updated.changes === 1;
    },
    options,
    { operationLabel: "logical-turn-effect-reset-replay-safe" },
  );
}

/**
 * Resolve an ambiguous effect with authenticated, generation-bound operator evidence.
 * `not_occurred` returns the same stable effect to planned; `occurred` records a
 * terminal reconciliation and still requires its transcript result checkpoint.
 */
export function reconcileLogicalTurnToolEffect(
  options: OpenClawAgentDatabaseOptions,
  params: {
    effectId: string;
    expectedGeneration: number;
    outcome: "occurred" | "not_occurred";
    operatorAuthorized: boolean;
    auditIdentity: string;
    coordinatorId: string;
    resultJson?: string;
    resultHash?: string;
    now?: number;
  },
): { reconciled: true; nextGeneration: number } | { reconciled: false; reason: "stale" } {
  if (!params.operatorAuthorized) {
    throw new Error("logical turn effect reconciliation requires authenticated operator scope");
  }
  const auditIdentity = params.auditIdentity.trim();
  const coordinatorId = params.coordinatorId.trim();
  if (!auditIdentity || !coordinatorId) {
    throw new Error("logical turn effect reconciliation requires audit and coordinator identity");
  }
  if (params.outcome === "occurred" && (!params.resultJson?.trim() || !params.resultHash?.trim())) {
    throw new Error(
      "occurred effect reconciliation requires the normalized result and fingerprint",
    );
  }
  if (
    params.outcome === "occurred" &&
    createHash("sha256").update(params.resultJson!).digest("hex") !== params.resultHash
  ) {
    throw new Error("occurred effect reconciliation result fingerprint does not match");
  }
  return runOpenClawAgentWriteTransaction(
    (database) => {
      ensureLogicalTurnSchema(database);
      const now = params.now ?? Date.now();
      const nextGeneration = params.expectedGeneration + 1;
      const reconciled =
        database.db /* sqlite-allow-raw: authenticated reconciliation is one generation-and-state CAS. */
          .prepare(
            `UPDATE logical_turn_effects
                SET effect_state = ?,
                    reconciliation_generation = ?,
                    reconciliation_outcome = ?,
                    reconciled_at = ?,
                    reconciled_by = ?,
                    coordinator_id = ?,
                    result_json = COALESCE(?, result_json),
                    result_hash = COALESCE(?, result_hash)
              WHERE effect_id = ? AND effect_state = 'unknown'
                AND reconciliation_generation = ?`,
          )
          .run(
            params.outcome === "occurred" ? "reconciled" : "planned",
            nextGeneration,
            params.outcome,
            now,
            auditIdentity,
            coordinatorId,
            params.resultJson ?? null,
            params.resultHash ?? null,
            params.effectId,
            params.expectedGeneration,
          );
      return reconciled.changes === 1
        ? { reconciled: true, nextGeneration }
        : { reconciled: false, reason: "stale" };
    },
    options,
    { operationLabel: "logical-turn-effect-reconcile" },
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
      const unresolvedEffect =
        database.db /* sqlite-allow-raw: an attempt cannot settle past an ambiguous or in-flight external boundary. */
          .prepare(
            `SELECT 1 AS present
             FROM logical_turn_effects
            WHERE logical_turn_id = ? AND effect_state IN ('dispatched', 'unknown')
            LIMIT 1`,
          )
          .get(params.logicalTurnId);
      if (unresolvedEffect) {
        return false;
      }
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
