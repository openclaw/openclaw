import fs from "node:fs";
import path from "node:path";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";

export type RestartRecoveryDeliveryContextRecord = {
  context: DeliveryContext;
  runId: string;
  sessionId: string;
  updatedAtMs: number;
};

function normalizeStorePath(storePath: string): string {
  const resolved = path.resolve(storePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function resolveStateDatabaseOptionsForStorePath(
  storePath: string,
  stateDir?: string,
): OpenClawStateDatabaseOptions {
  if (stateDir) {
    return {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      },
    };
  }
  const normalized = normalizeStorePath(storePath);
  if (path.basename(normalized) !== "sessions.json") {
    return {};
  }
  const sessionsDir = path.dirname(normalized);
  if (path.basename(sessionsDir) !== "sessions") {
    return {};
  }
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(agentsDir) !== "agents") {
    return {};
  }
  return {
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: path.dirname(agentsDir),
    },
  };
}

function normalizeRowContext(value: string): DeliveryContext | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const candidate = parsed as Partial<DeliveryContext>;
    return normalizeDeliveryContext({
      channel: candidate.channel,
      to: candidate.to,
      accountId: candidate.accountId,
      threadId: candidate.threadId,
    });
  } catch {
    return undefined;
  }
}

export function claimRestartRecoveryDeliveryContext(params: {
  context: DeliveryContext;
  runId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  replaceExisting?: boolean;
  stateDir?: string;
  updatedAtMs?: number;
}): boolean {
  const context = normalizeDeliveryContext(params.context);
  if (!context?.channel || !context.to) {
    return false;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const storePath = normalizeStorePath(params.storePath);
      const existing = db
        .prepare(
          `SELECT run_id AS runId, session_id AS sessionId
           FROM restart_recovery_delivery_contexts
          WHERE store_path = ? AND session_key = ?`,
        )
        .get(storePath, params.sessionKey) as { runId?: unknown; sessionId?: unknown } | undefined;
      if (
        existing?.sessionId === params.sessionId &&
        existing.runId !== params.runId &&
        !params.replaceExisting
      ) {
        return false;
      }
      db.prepare(
        `INSERT INTO restart_recovery_delivery_contexts (
         store_path,
         session_key,
         session_id,
         run_id,
         context_json,
         updated_at_ms
       )
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(store_path, session_key) DO UPDATE SET
         session_id = excluded.session_id,
         run_id = excluded.run_id,
         context_json = excluded.context_json,
         updated_at_ms = excluded.updated_at_ms`,
      ).run(
        storePath,
        params.sessionKey,
        params.sessionId,
        params.runId,
        JSON.stringify(context),
        params.updatedAtMs ?? Date.now(),
      );
      return true;
    },
    resolveStateDatabaseOptionsForStorePath(params.storePath, params.stateDir),
  );
}

export function readRestartRecoveryDeliveryContext(params: {
  sessionId?: string;
  sessionKey: string;
  stateDir?: string;
  storePath: string;
}): RestartRecoveryDeliveryContextRecord | undefined {
  const { db } = openOpenClawStateDatabase(
    resolveStateDatabaseOptionsForStorePath(params.storePath, params.stateDir),
  );
  const row = db
    .prepare(
      `SELECT session_id AS sessionId,
                run_id AS runId,
                context_json AS contextJson,
                updated_at_ms AS updatedAtMs
           FROM restart_recovery_delivery_contexts
          WHERE store_path = ? AND session_key = ?`,
    )
    .get(normalizeStorePath(params.storePath), params.sessionKey) as
    | {
        contextJson?: unknown;
        runId?: unknown;
        sessionId?: unknown;
        updatedAtMs?: unknown;
      }
    | undefined;
  if (!row || (params.sessionId && row.sessionId !== params.sessionId)) {
    return undefined;
  }
  if (
    typeof row.contextJson !== "string" ||
    typeof row.runId !== "string" ||
    typeof row.sessionId !== "string" ||
    typeof row.updatedAtMs !== "number"
  ) {
    return undefined;
  }
  const context = normalizeRowContext(row.contextJson);
  if (!context?.channel || !context.to) {
    return undefined;
  }
  return {
    context,
    runId: row.runId,
    sessionId: row.sessionId,
    updatedAtMs: row.updatedAtMs,
  };
}

export function clearRestartRecoveryDeliveryContext(params: {
  runId?: string;
  sessionId?: string;
  sessionKey: string;
  stateDir?: string;
  storePath: string;
}): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const storePath = normalizeStorePath(params.storePath);
      const result =
        params.runId && params.sessionId
          ? db
              .prepare(
                `DELETE FROM restart_recovery_delivery_contexts
              WHERE store_path = ?
                AND session_key = ?
                AND session_id = ?
                AND run_id = ?`,
              )
              .run(storePath, params.sessionKey, params.sessionId, params.runId)
          : params.sessionId
            ? db
                .prepare(
                  `DELETE FROM restart_recovery_delivery_contexts
                WHERE store_path = ?
                  AND session_key = ?
                  AND session_id = ?`,
                )
                .run(storePath, params.sessionKey, params.sessionId)
            : db
                .prepare(
                  `DELETE FROM restart_recovery_delivery_contexts
                WHERE store_path = ? AND session_key = ?`,
                )
                .run(storePath, params.sessionKey);
      return Number(result.changes ?? 0) > 0;
    },
    resolveStateDatabaseOptionsForStorePath(params.storePath, params.stateDir),
  );
}

export function clearRestartRecoveryDeliveryContextsForTest(): void {
  if (!process.env.VITEST) {
    throw new Error("clearRestartRecoveryDeliveryContextsForTest is test-only.");
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare("DELETE FROM restart_recovery_delivery_contexts").run();
  });
}
