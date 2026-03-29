import { loadConfig } from "../config/config.js";
import { ensureContextEnginesInitialized } from "../context-engine/init.js";
import { resolveContextEngine } from "../context-engine/registry.js";
import type { SubagentEndReason } from "../context-engine/types.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";
import { resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";
import type { SubagentRunOutcome } from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  ANNOUNCE_EXPIRY_MS,
  MAX_ANNOUNCE_RETRY_COUNT,
  reconcileOrphanedRestoredRuns,
  reconcileOrphanedRun,
  resolveAnnounceRetryDelayMs,
  resolveSubagentRunOrphanReason,
  resolveSubagentSessionStatus,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsExcludingRunFromRuns,
  countPendingDescendantRunsFromRuns,
  findRunIdsByChildSessionKeyFromRuns,
  listRunsForControllerFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import { createSubagentRunManager } from "./subagent-registry-run-manager.js";
import {
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type { SubagentRunRecord } from "./subagent-registry.types.js";
export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-registry-helpers.js";
const log = createSubsystemLogger("agents/subagent-registry");

let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while provider/model
 * retry is still in progress. Defer terminal error cleanup briefly so a
 * subsequent lifecycle `start` / `end` can cancel premature failure announces.
 */
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;

function persistSubagentRuns() {
  persistSubagentRunsToDisk(subagentRuns);
}

const resumedRuns = new Set<string>();
const endedHookInFlightRunIds = new Set<string>();
const pendingLifecycleErrorByRunId = new Map<
  string,
  {
    timer: NodeJS.Timeout;
    endedAt: number;
    error?: string;
  }
>();

function clearPendingLifecycleError(runId: string) {
  const pending = pendingLifecycleErrorByRunId.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingLifecycleErrorByRunId.delete(runId);
}

function clearAllPendingLifecycleErrors() {
  for (const pending of pendingLifecycleErrorByRunId.values()) {
    clearTimeout(pending.timer);
  }
  pendingLifecycleErrorByRunId.clear();
}

function schedulePendingLifecycleError(params: { runId: string; endedAt: number; error?: string }) {
  clearPendingLifecycleError(params.runId);
  const timer = setTimeout(() => {
    const pending = pendingLifecycleErrorByRunId.get(params.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    pendingLifecycleErrorByRunId.delete(params.runId);
    const entry = subagentRuns.get(params.runId);
    if (!entry) {
      return;
    }
    if (entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE || entry.outcome?.status === "ok") {
      return;
    }
    void completeSubagentRun({
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "error",
        error: pending.error,
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    });
  }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleErrorByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    error: params.error,
  });
}

async function notifyContextEngineSubagentEnded(params: {
  childSessionKey: string;
  reason: SubagentEndReason;
  workspaceDir?: string;
}) {
  try {
    const cfg = loadConfig();
    ensureRuntimePluginsLoaded({
      config: cfg,
      workspaceDir: params.workspaceDir,
      allowGatewaySubagentBinding: true,
    });
    ensureContextEnginesInitialized();
    const engine = await resolveContextEngine(cfg);
    if (!engine.onSubagentEnded) {
      return;
    }
    await engine.onSubagentEnded(params);
  } catch (err) {
    log.warn("context-engine onSubagentEnded failed (best-effort)", { err });
  }
}

function suppressAnnounceForSteerRestart(entry?: SubagentRunRecord) {
  return entry?.suppressAnnounceReason === "steer-restart";
}

function shouldKeepThreadBindingAfterRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  if (params.reason === SUBAGENT_ENDED_REASON_KILLED) {
    return false;
  }
  return params.entry.spawnMode === "session";
}

function shouldEmitEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  return !shouldKeepThreadBindingAfterRun(params);
}

async function emitSubagentEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason?: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
}) {
  const cfg = loadConfig();
  ensureRuntimePluginsLoaded({
    config: cfg,
    workspaceDir: params.entry.workspaceDir,
    allowGatewaySubagentBinding: true,
  });
  const reason = params.reason ?? params.entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  const outcome = resolveLifecycleOutcomeFromRunOutcome(params.entry.outcome);
  const error = params.entry.outcome?.status === "error" ? params.entry.outcome.error : undefined;
  await emitSubagentEndedHookOnce({
    entry: params.entry,
    reason,
    sendFarewell: params.sendFarewell,
    accountId: params.accountId ?? params.entry.requesterOrigin?.accountId,
    outcome,
    error,
    inFlightRunIds: endedHookInFlightRunIds,
    persist: persistSubagentRuns,
  });
}

const subagentLifecycleController = createSubagentRegistryLifecycleController({
  runs: subagentRuns,
  resumedRuns,
  subagentAnnounceTimeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
  persist: persistSubagentRuns,
  clearPendingLifecycleError,
  countPendingDescendantRuns,
  suppressAnnounceForSteerRestart,
  shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun,
  notifyContextEngineSubagentEnded,
  resumeSubagentRun,
  warn: (message, meta) => log.warn(message, meta),
});

const {
  completeCleanupBookkeeping,
  completeSubagentRun,
  finalizeResumedAnnounceGiveUp,
  refreshFrozenResultFromSession,
  startSubagentAnnounceCleanupFlow,
} = subagentLifecycleController;

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) {
    return;
  }
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  const orphanReason = resolveSubagentRunOrphanReason({ entry });
  if (orphanReason) {
    if (
      reconcileOrphanedRun({
        runId,
        entry,
        reason: orphanReason,
        source: "resume",
        runs: subagentRuns,
        resumedRuns,
      })
    ) {
      persistSubagentRuns();
    }
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }
  // Skip entries that have exhausted their retry budget or expired (#18264).
  if ((entry.announceRetryCount ?? 0) >= MAX_ANNOUNCE_RETRY_COUNT) {
    void finalizeResumedAnnounceGiveUp({
      runId,
      entry,
      reason: "retry-limit",
    });
    return;
  }
  if (
    entry.expectsCompletionMessage !== true &&
    typeof entry.endedAt === "number" &&
    Date.now() - entry.endedAt > ANNOUNCE_EXPIRY_MS
  ) {
    void finalizeResumedAnnounceGiveUp({
      runId,
      entry,
      reason: "expiry",
    });
    return;
  }

  const now = Date.now();
  const delayMs = resolveAnnounceRetryDelayMs(entry.announceRetryCount ?? 0);
  const earliestRetryAt = (entry.lastAnnounceRetryAt ?? 0) + delayMs;
  if (
    entry.expectsCompletionMessage === true &&
    entry.lastAnnounceRetryAt &&
    now < earliestRetryAt
  ) {
    const waitMs = Math.max(1, earliestRetryAt - now);
    setTimeout(() => {
      resumedRuns.delete(runId);
      resumeSubagentRun(runId);
    }, waitMs).unref?.();
    resumedRuns.add(runId);
    return;
  }

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    if (suppressAnnounceForSteerRestart(entry)) {
      resumedRuns.add(runId);
      return;
    }
    if (!startSubagentAnnounceCleanupFlow(runId, entry)) {
      return;
    }
    resumedRuns.add(runId);
    return;
  }

  // Wait for completion again after restart.
  const cfg = loadConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds);
  void subagentRunManager.waitForSubagentCompletion(runId, waitTimeoutMs);
  resumedRuns.add(runId);
}

function restoreSubagentRunsOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restoredCount = restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true,
    });
    if (restoredCount === 0) {
      return;
    }
    if (
      reconcileOrphanedRestoredRuns({
        runs: subagentRuns,
        resumedRuns,
      })
    ) {
      persistSubagentRuns();
    }
    if (subagentRuns.size === 0) {
      return;
    }
    // Resume pending work.
    ensureListener();
    if ([...subagentRuns.values()].some((entry) => entry.archiveAtMs)) {
      startSweeper();
    }
    for (const runId of subagentRuns.keys()) {
      resumeSubagentRun(runId);
    }

    // Schedule orphan recovery for subagent sessions that were aborted
    // by a SIGUSR1 reload. This runs after a short delay to let the
    // gateway fully bootstrap first. Dynamic import to avoid increasing
    // startup memory footprint. (#47711)
    void import("./subagent-orphan-recovery.js").then(
      ({ scheduleOrphanRecovery }) => {
        scheduleOrphanRecovery({ getActiveRuns: () => subagentRuns });
      },
      () => {
        // Ignore import failures — orphan recovery is best-effort.
      },
    );
  } catch {
    // ignore restore failures
  }
}

function resolveSubagentWaitTimeoutMs(
  cfg: ReturnType<typeof loadConfig>,
  runTimeoutSeconds?: number,
) {
  return resolveAgentTimeoutMs({ cfg, overrideSeconds: runTimeoutSeconds ?? 0 });
}

function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(() => {
    void sweepSubagentRuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

async function sweepSubagentRuns() {
  const now = Date.now();
  let mutated = false;
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!entry.archiveAtMs || entry.archiveAtMs > now) {
      continue;
    }
    clearPendingLifecycleError(runId);
    void notifyContextEngineSubagentEnded({
      childSessionKey: entry.childSessionKey,
      reason: "swept",
      workspaceDir: entry.workspaceDir,
    });
    subagentRuns.delete(runId);
    mutated = true;
    // Archive/purge is terminal for the run record; remove any retained attachments too.
    await safeRemoveAttachmentsDir(entry);
    try {
      await callGateway({
        method: "sessions.delete",
        params: {
          key: entry.childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // ignore
    }
  }
  if (mutated) {
    persistSubagentRuns();
  }
  if (subagentRuns.size === 0) {
    stopSweeper();
  }
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = onAgentEvent((evt) => {
    void (async () => {
      if (!evt || evt.stream !== "lifecycle") {
        return;
      }
      const phase = evt.data?.phase;
      const entry = subagentRuns.get(evt.runId);
      if (!entry) {
        if (phase === "end" && typeof evt.sessionKey === "string") {
          await refreshFrozenResultFromSession(evt.sessionKey);
        }
        return;
      }
      if (phase === "start") {
        clearPendingLifecycleError(evt.runId);
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
        if (startedAt) {
          entry.startedAt = startedAt;
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = startedAt;
          }
          persistSubagentRuns();
        }
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      if (phase === "error") {
        schedulePendingLifecycleError({
          runId: evt.runId,
          endedAt,
          error,
        });
        return;
      }
      clearPendingLifecycleError(evt.runId);
      const outcome: SubagentRunOutcome = evt.data?.aborted
        ? { status: "timeout" }
        : { status: "ok" };
      await completeSubagentRun({
        runId: evt.runId,
        endedAt,
        outcome,
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      });
    })();
  });
}

const subagentRunManager = createSubagentRunManager({
  runs: subagentRuns,
  resumedRuns,
  endedHookInFlightRunIds,
  persist: persistSubagentRuns,
  ensureListener,
  startSweeper,
  stopSweeper,
  resumeSubagentRun,
  clearPendingLifecycleError,
  resolveSubagentWaitTimeoutMs,
  notifyContextEngineSubagentEnded,
  completeCleanupBookkeeping,
  completeSubagentRun,
});

export function markSubagentRunForSteerRestart(runId: string) {
  return subagentRunManager.markSubagentRunForSteerRestart(runId);
}

export function clearSubagentRunSteerRestart(runId: string) {
  return subagentRunManager.clearSubagentRunSteerRestart(runId);
}

export function replaceSubagentRunAfterSteer(params: {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
}) {
  return subagentRunManager.replaceSubagentRunAfterSteer(params);
}

export function registerSubagentRun(params: {
  runId: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
}) {
  subagentRunManager.registerSubagentRun(params);
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  subagentRuns.clear();
  resumedRuns.clear();
  endedHookInFlightRunIds.clear();
  clearAllPendingLifecycleErrors();
  resetAnnounceQueuesForTests();
  resetTaskRegistryForTests({ persist: opts?.persist });
  stopSweeper();
  restoreAttempted = false;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

export function releaseSubagentRun(runId: string) {
  subagentRunManager.releaseSubagentRun(runId);
}

function findRunIdsByChildSessionKey(childSessionKey: string): string[] {
  return findRunIdsByChildSessionKeyFromRuns(subagentRuns, childSessionKey);
}

export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const resolved = resolveRequesterForChildSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
  if (!resolved) {
    return null;
  }
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin),
  };
}

export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  const runIds = findRunIdsByChildSessionKey(childSessionKey);
  let latest: SubagentRunRecord | undefined;
  for (const runId of runIds) {
    const entry = subagentRuns.get(runId);
    if (!entry) {
      continue;
    }
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }
  return Boolean(latest && typeof latest.endedAt !== "number");
}

export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function markSubagentRunTerminated(params: {
  runId?: string;
  childSessionKey?: string;
  reason?: string;
}): number {
  return subagentRunManager.markSubagentRunTerminated(params);
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string },
): SubagentRunRecord[] {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
}

export function countActiveRunsForSession(requesterSessionKey: string): number {
  return countActiveRunsForSessionFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    requesterSessionKey,
  );
}

export function countActiveDescendantRuns(rootSessionKey: string): number {
  return countActiveDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function countPendingDescendantRunsExcludingRun(
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsExcludingRunFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    excludeRunId,
  );
}

export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latestActive: SubagentRunRecord | null = null;
  let latestEnded: SubagentRunRecord | null = null;
  for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (typeof entry.endedAt !== "number") {
      if (!latestActive || entry.createdAt > latestActive.createdAt) {
        latestActive = entry;
      }
      continue;
    }
    if (!latestEnded || entry.createdAt > latestEnded.createdAt) {
      latestEnded = entry;
    }
  }

  return latestActive ?? latestEnded;
}

export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latest: SubagentRunRecord | null = null;
  for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }

  return latest;
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}
