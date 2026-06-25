import type { SessionEntry } from "../config/sessions.js";
// Reconciles persisted session lifecycle when runtime state has already ended.
import { applyRestartRecoveryLifecycle } from "../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  listFreshTasksForOwnerKey,
  listTasksForRelatedSessionKey,
  listTasksForSessionKey,
} from "../tasks/task-registry.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";

const log = createSubsystemLogger("session-running-reconciliation");

const STALE_RUNNING_STATUSES = new Set(["running", "processing"]);

export type SessionRunningReconciliationResult = {
  changed: boolean;
  sessionKey: string;
  oldStatus?: string;
  newStatus?: string;
  activeRunPresent: boolean;
  runningTaskCount: number;
  reason: string;
  safeFallbackDelivered: boolean;
};

type MutableSessionEntry = SessionEntry & Record<string, unknown>;

function uniqueTasks(tasks: TaskRecord[]): TaskRecord[] {
  const byId = new Map<string, TaskRecord>();
  for (const task of tasks) {
    byId.set(task.taskId, task);
  }
  return [...byId.values()];
}

export function countRunningTasksForSessionKey(sessionKey: string | undefined): number {
  const key = sessionKey?.trim();
  if (!key) {
    return 0;
  }
  try {
    return uniqueTasks([
      ...listFreshTasksForOwnerKey(key),
      ...listTasksForSessionKey(key),
      ...listTasksForRelatedSessionKey(key),
    ]).filter((task) => task.status === "running").length;
  } catch (error) {
    log.warn("failed to count running tasks for persisted session reconciliation", {
      sessionKey: key,
      error: String(error),
    });
    return 1;
  }
}

function clearInterruptedDeliveryState(entry: MutableSessionEntry): void {
  entry.pendingFinalDelivery = undefined;
  entry.pendingFinalDeliveryText = undefined;
  entry.pendingFinalDeliveryCreatedAt = undefined;
  entry.pendingFinalDeliveryLastAttemptAt = undefined;
  entry.pendingFinalDeliveryAttemptCount = undefined;
  entry.pendingFinalDeliveryLastError = undefined;
  entry.pendingFinalDeliveryContext = undefined;
  entry.pendingFinalDeliveryIntentId = undefined;
  entry.restartRecoveryDeliveryRunId = undefined;
  entry.restartRecoveryDeliveryContext = undefined;
}

function markEntryTerminal(params: {
  entry: MutableSessionEntry;
  now: number;
  newStatus: NonNullable<SessionEntry["status"]>;
  reason: string;
  safeFallbackDelivered: boolean;
}): void {
  params.entry.status = params.newStatus;
  params.entry.abortedLastRun = true;
  params.entry.endedAt = params.now;
  params.entry.updatedAt = params.now;
  if (typeof params.entry.startedAt === "number") {
    params.entry.runtimeMs = Math.max(0, params.now - params.entry.startedAt);
  }
  params.entry.recoveredFromStaleRunning = true;
  params.entry.staleRunningRecoveryReason = params.reason;
  params.entry.staleRunningRecoveredAt = params.now;
  params.entry.safeFallbackDelivered = params.safeFallbackDelivered;
  clearInterruptedDeliveryState(params.entry);
}

function logReconciliation(result: SessionRunningReconciliationResult): void {
  log.warn("reconciled persisted running session", {
    sessionKey: result.sessionKey,
    oldStatus: result.oldStatus ?? null,
    newStatus: result.newStatus ?? null,
    activeRunPresent: result.activeRunPresent,
    runningTaskCount: result.runningTaskCount,
    recoveryReason: result.reason,
    safeFallbackDelivered: result.safeFallbackDelivered,
  });
}

export async function reconcilePersistedRunningSession(params: {
  storePath: string;
  sessionKey: string;
  candidateSessionKeys?: Iterable<string | undefined>;
  activeRunPresent: boolean;
  reason: string;
  safeFallbackDelivered?: boolean;
  newStatus?: "failed";
}): Promise<SessionRunningReconciliationResult> {
  const primarySessionKey = params.sessionKey.trim();
  const candidateKeys = new Set(
    [primarySessionKey, ...(params.candidateSessionKeys ?? [])]
      .map((key) => key?.trim())
      .filter((key): key is string => Boolean(key)),
  );
  const runningTaskCount = countRunningTasksForSessionKey(primarySessionKey);
  const baseResult: SessionRunningReconciliationResult = {
    changed: false,
    sessionKey: primarySessionKey,
    activeRunPresent: params.activeRunPresent,
    runningTaskCount,
    reason: params.reason,
    safeFallbackDelivered: params.safeFallbackDelivered === true,
  };
  if (!params.storePath || !primarySessionKey || params.activeRunPresent || runningTaskCount > 0) {
    return baseResult;
  }

  const newStatus: NonNullable<SessionEntry["status"]> = params.newStatus ?? "failed";
  const now = Date.now();
  let changedResult: SessionRunningReconciliationResult | undefined;
  await applyRestartRecoveryLifecycle({
    storePath: params.storePath,
    requireWriteSuccess: true,
    update: (entries) => {
      const current = entries.find(({ sessionKey }) => candidateKeys.has(sessionKey));
      const entry = current?.entry as MutableSessionEntry | undefined;
      if (!current || !entry) {
        return { result: undefined };
      }
      const oldStatus = typeof entry.status === "string" ? entry.status : undefined;
      if (!oldStatus || !STALE_RUNNING_STATUSES.has(oldStatus)) {
        return { result: undefined };
      }
      markEntryTerminal({
        entry,
        now,
        newStatus,
        reason: params.reason,
        safeFallbackDelivered: params.safeFallbackDelivered === true,
      });
      changedResult = {
        ...baseResult,
        changed: true,
        sessionKey: current.sessionKey,
        oldStatus,
        newStatus,
      };
      return {
        result: undefined,
        replacements: [{ sessionKey: current.sessionKey, entry }],
      };
    },
  });
  if (changedResult) {
    logReconciliation(changedResult);
    return changedResult;
  }
  return baseResult;
}

export async function reconcilePersistedRunningSessionsInStore(params: {
  storePath: string;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  reason: string;
  safeFallbackDelivered?: boolean;
  updatedBeforeMs?: number;
}): Promise<{ reconciled: number; skippedActive: number; skippedTask: number }> {
  const activeSessionIds = new Set(
    [...(params.activeSessionIds ?? [])].map((value) => value.trim()).filter(Boolean),
  );
  const activeSessionKeys = new Set(
    [...(params.activeSessionKeys ?? [])].map((value) => value.trim()).filter(Boolean),
  );
  const result = { reconciled: 0, skippedActive: 0, skippedTask: 0 };
  const now = Date.now();
  await applyRestartRecoveryLifecycle({
    storePath: params.storePath,
    requireWriteSuccess: true,
    update: (entries) => {
      const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
      for (const { sessionKey, entry } of entries) {
        const mutable = entry as MutableSessionEntry;
        const oldStatus = typeof mutable.status === "string" ? mutable.status : undefined;
        if (!oldStatus || !STALE_RUNNING_STATUSES.has(oldStatus)) {
          continue;
        }
        const updatedAt = typeof mutable.updatedAt === "number" ? mutable.updatedAt : undefined;
        if (
          params.updatedBeforeMs !== undefined &&
          updatedAt !== undefined &&
          updatedAt > params.updatedBeforeMs
        ) {
          continue;
        }
        const activeRunPresent =
          activeSessionKeys.has(sessionKey) ||
          (typeof mutable.sessionId === "string" && activeSessionIds.has(mutable.sessionId));
        if (activeRunPresent) {
          result.skippedActive++;
          continue;
        }
        const runningTaskCount = countRunningTasksForSessionKey(sessionKey);
        if (runningTaskCount > 0) {
          result.skippedTask++;
          continue;
        }
        markEntryTerminal({
          entry: mutable,
          now,
          newStatus: "failed",
          reason: params.reason,
          safeFallbackDelivered: params.safeFallbackDelivered === true,
        });
        replacements.push({ sessionKey, entry: mutable });
        result.reconciled++;
        logReconciliation({
          changed: true,
          sessionKey,
          oldStatus,
          newStatus: "failed",
          activeRunPresent,
          runningTaskCount,
          reason: params.reason,
          safeFallbackDelivered: params.safeFallbackDelivered === true,
        });
      }
      return { result, replacements };
    },
  });
  return result;
}
