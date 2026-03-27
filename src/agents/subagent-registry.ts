import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { ensureContextEnginesInitialized } from "../context-engine/init.js";
import { resolveContextEngine } from "../context-engine/registry.js";
import type { SubagentEndReason } from "../context-engine/types.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";
import { resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
  type SubagentRunOutcome,
} from "./subagent-announce.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  resolveCleanupCompletionReason,
  resolveDeferredCleanupDecision,
} from "./subagent-registry-cleanup.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
  runOutcomesEqual,
} from "./subagent-registry-completion.js";
import {
  ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
  ANNOUNCE_EXPIRY_MS,
  capFrozenResultText,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  logAnnounceGiveUp,
  MAX_ANNOUNCE_RETRY_COUNT,
  MIN_ANNOUNCE_RETRY_DELAY_MS,
  persistSubagentSessionTiming,
  reconcileOrphanedRestoredRuns,
  reconcileOrphanedRun,
  resolveAnnounceRetryDelayMs,
  resolveSubagentRunOrphanReason,
  resolveSubagentSessionStatus,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
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

async function freezeRunResultAtCompletion(entry: SubagentRunRecord): Promise<boolean> {
  if (entry.frozenResultText !== undefined) {
    return false;
  }
  try {
    const captured = await captureSubagentCompletionReply(entry.childSessionKey);
    entry.frozenResultText = captured?.trim() ? capFrozenResultText(captured) : null;
  } catch {
    entry.frozenResultText = null;
  }
  entry.frozenResultCapturedAt = Date.now();
  return true;
}

function listPendingCompletionRunsForSession(sessionKey: string): SubagentRunRecord[] {
  const key = sessionKey.trim();
  if (!key) {
    return [];
  }
  const out: SubagentRunRecord[] = [];
  for (const entry of subagentRuns.values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (entry.expectsCompletionMessage !== true) {
      continue;
    }
    if (typeof entry.endedAt !== "number") {
      continue;
    }
    if (typeof entry.cleanupCompletedAt === "number") {
      continue;
    }
    out.push(entry);
  }
  return out;
}

async function refreshFrozenResultFromSession(sessionKey: string): Promise<boolean> {
  const candidates = listPendingCompletionRunsForSession(sessionKey);
  if (candidates.length === 0) {
    return false;
  }

  let captured: string | undefined;
  try {
    captured = await captureSubagentCompletionReply(sessionKey);
  } catch {
    return false;
  }
  const trimmed = captured?.trim();
  if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
    return false;
  }

  const nextFrozen = capFrozenResultText(trimmed);
  const capturedAt = Date.now();
  let changed = false;
  for (const entry of candidates) {
    if (entry.frozenResultText === nextFrozen) {
      continue;
    }
    entry.frozenResultText = nextFrozen;
    entry.frozenResultCapturedAt = capturedAt;
    changed = true;
  }
  if (changed) {
    persistSubagentRuns();
  }
  return changed;
}

async function completeSubagentRun(params: {
  runId: string;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
}) {
  clearPendingLifecycleError(params.runId);
  const entry = subagentRuns.get(params.runId);
  if (!entry) {
    return;
  }

  let mutated = false;
  // If a late lifecycle completion arrives after an earlier kill marker, allow
  // completion cleanup/announce to run instead of staying permanently suppressed.
  if (
    params.reason === SUBAGENT_ENDED_REASON_COMPLETE &&
    entry.suppressAnnounceReason === "killed" &&
    (entry.cleanupHandled || typeof entry.cleanupCompletedAt === "number")
  ) {
    entry.suppressAnnounceReason = undefined;
    entry.cleanupHandled = false;
    entry.cleanupCompletedAt = undefined;
    mutated = true;
  }

  const endedAt = typeof params.endedAt === "number" ? params.endedAt : Date.now();
  if (entry.endedAt !== endedAt) {
    entry.endedAt = endedAt;
    mutated = true;
  }
  if (!runOutcomesEqual(entry.outcome, params.outcome)) {
    entry.outcome = params.outcome;
    mutated = true;
  }
  if (entry.endedReason !== params.reason) {
    entry.endedReason = params.reason;
    mutated = true;
  }

  if (await freezeRunResultAtCompletion(entry)) {
    mutated = true;
  }

  if (mutated) {
    persistSubagentRuns();
  }

  try {
    await persistSubagentSessionTiming(entry);
  } catch (err) {
    log.warn("failed to persist subagent session timing", {
      err,
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
    });
  }

  const suppressedForSteerRestart = suppressAnnounceForSteerRestart(entry);
  if (mutated && !suppressedForSteerRestart) {
    // The gateway also emits sessions.changed directly from raw lifecycle
    // events, but for subagent sessions the visible status comes from this
    // registry. When a restarted follow-up run ends, the raw lifecycle `end`
    // event can reach websocket subscribers before this registry records
    // endedAt/outcome, leaving the dashboard stuck on the stale "running"
    // snapshot. Emit a follow-up lifecycle change after persisting the
    // registry update so subscribers receive the authoritative completed
    // status.
    emitSessionLifecycleEvent({
      sessionKey: entry.childSessionKey,
      reason: "subagent-status",
      parentSessionKey: entry.requesterSessionKey,
      label: entry.label,
    });
  }
  const shouldEmitEndedHook =
    !suppressedForSteerRestart &&
    shouldEmitEndedHookForRun({
      entry,
      reason: params.reason,
    });
  const shouldDeferEndedHook =
    shouldEmitEndedHook &&
    params.triggerCleanup &&
    entry.expectsCompletionMessage === true &&
    !suppressedForSteerRestart;
  if (!shouldDeferEndedHook && shouldEmitEndedHook) {
    await emitSubagentEndedHookForRun({
      entry,
      reason: params.reason,
      sendFarewell: params.sendFarewell,
      accountId: params.accountId,
    });
  }

  if (!params.triggerCleanup) {
    return;
  }
  if (suppressedForSteerRestart) {
    return;
  }
  startSubagentAnnounceCleanupFlow(params.runId, entry);
}

function startSubagentAnnounceCleanupFlow(runId: string, entry: SubagentRunRecord): boolean {
  if (!beginSubagentCleanup(runId)) {
    return false;
  }
  const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
  const finalizeAnnounceCleanup = (didAnnounce: boolean) => {
    void finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce).catch((err) => {
      defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
      const current = subagentRuns.get(runId);
      if (!current || current.cleanupCompletedAt) {
        return;
      }
      current.cleanupHandled = false;
      persistSubagentRuns();
    });
  };

  void runSubagentAnnounceFlow({
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    requesterSessionKey: entry.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: entry.requesterDisplayKey,
    task: entry.task,
    timeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
    cleanup: entry.cleanup,
    roundOneReply: entry.frozenResultText ?? undefined,
    fallbackReply: entry.fallbackFrozenResultText ?? undefined,
    waitForCompletion: false,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    label: entry.label,
    outcome: entry.outcome,
    spawnMode: entry.spawnMode,
    expectsCompletionMessage: entry.expectsCompletionMessage,
    wakeOnDescendantSettle: entry.wakeOnDescendantSettle === true,
  })
    .then((didAnnounce) => {
      finalizeAnnounceCleanup(didAnnounce);
    })
    .catch((error) => {
      defaultRuntime.log(
        `[warn] Subagent announce flow failed during cleanup for run ${runId}: ${String(error)}`,
      );
      finalizeAnnounceCleanup(false);
    });
  return true;
}

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

async function finalizeSubagentCleanup(
  runId: string,
  cleanup: "delete" | "keep",
  didAnnounce: boolean,
) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (didAnnounce) {
    entry.wakeOnDescendantSettle = undefined;
    entry.fallbackFrozenResultText = undefined;
    entry.fallbackFrozenResultCapturedAt = undefined;
    const completionReason = resolveCleanupCompletionReason(entry);
    await emitCompletionEndedHookIfNeeded(entry, completionReason);
    // Clean up attachments before the run record is removed.
    const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(entry);
    }
    if (cleanup === "delete") {
      entry.frozenResultText = undefined;
      entry.frozenResultCapturedAt = undefined;
    }
    completeCleanupBookkeeping({
      runId,
      entry,
      cleanup,
      completedAt: Date.now(),
    });
    return;
  }

  const now = Date.now();
  const deferredDecision = resolveDeferredCleanupDecision({
    entry,
    now,
    // Defer until descendants are fully settled, including post-end cleanup.
    activeDescendantRuns: Math.max(0, countPendingDescendantRuns(entry.childSessionKey)),
    announceExpiryMs: ANNOUNCE_EXPIRY_MS,
    announceCompletionHardExpiryMs: ANNOUNCE_COMPLETION_HARD_EXPIRY_MS,
    maxAnnounceRetryCount: MAX_ANNOUNCE_RETRY_COUNT,
    deferDescendantDelayMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
    resolveAnnounceRetryDelayMs,
  });

  if (deferredDecision.kind === "defer-descendants") {
    entry.lastAnnounceRetryAt = now;
    entry.wakeOnDescendantSettle = true;
    entry.cleanupHandled = false;
    resumedRuns.delete(runId);
    persistSubagentRuns();
    setTimeout(() => {
      resumeSubagentRun(runId);
    }, deferredDecision.delayMs).unref?.();
    return;
  }

  if (deferredDecision.retryCount != null) {
    entry.announceRetryCount = deferredDecision.retryCount;
    entry.lastAnnounceRetryAt = now;
  }

  if (deferredDecision.kind === "give-up") {
    entry.wakeOnDescendantSettle = undefined;
    entry.fallbackFrozenResultText = undefined;
    entry.fallbackFrozenResultCapturedAt = undefined;
    const shouldDeleteAttachments = cleanup === "delete" || !entry.retainAttachmentsOnKeep;
    if (shouldDeleteAttachments) {
      await safeRemoveAttachmentsDir(entry);
    }
    const completionReason = resolveCleanupCompletionReason(entry);
    await emitCompletionEndedHookIfNeeded(entry, completionReason);
    logAnnounceGiveUp(entry, deferredDecision.reason);
    completeCleanupBookkeeping({
      runId,
      entry,
      cleanup,
      completedAt: now,
    });
    return;
  }

  // Keep both cleanup modes retryable after deferred/failed announce.
  // Delete-mode is finalized only after announce succeeds or give-up triggers.
  entry.cleanupHandled = false;
  // Clear the in-flight resume marker so the scheduled retry can run again.
  resumedRuns.delete(runId);
  persistSubagentRuns();
  if (deferredDecision.resumeDelayMs == null) {
    return;
  }
  setTimeout(() => {
    resumeSubagentRun(runId);
  }, deferredDecision.resumeDelayMs).unref?.();
}

async function finalizeResumedAnnounceGiveUp(params: {
  runId: string;
  entry: SubagentRunRecord;
  reason: "retry-limit" | "expiry";
}) {
  params.entry.wakeOnDescendantSettle = undefined;
  params.entry.fallbackFrozenResultText = undefined;
  params.entry.fallbackFrozenResultCapturedAt = undefined;
  const shouldDeleteAttachments =
    params.entry.cleanup === "delete" || !params.entry.retainAttachmentsOnKeep;
  if (shouldDeleteAttachments) {
    await safeRemoveAttachmentsDir(params.entry);
  }
  const completionReason = resolveCleanupCompletionReason(params.entry);
  await emitCompletionEndedHookIfNeeded(params.entry, completionReason);
  logAnnounceGiveUp(params.entry, params.reason);
  completeCleanupBookkeeping({
    runId: params.runId,
    entry: params.entry,
    cleanup: params.entry.cleanup,
    completedAt: Date.now(),
  });
}

async function emitCompletionEndedHookIfNeeded(
  entry: SubagentRunRecord,
  reason: SubagentLifecycleEndedReason,
) {
  if (
    entry.expectsCompletionMessage === true &&
    shouldEmitEndedHookForRun({
      entry,
      reason,
    })
  ) {
    await emitSubagentEndedHookForRun({
      entry,
      reason,
      sendFarewell: true,
    });
  }
}

function completeCleanupBookkeeping(params: {
  runId: string;
  entry: SubagentRunRecord;
  cleanup: "delete" | "keep";
  completedAt: number;
}) {
  if (params.cleanup === "delete") {
    clearPendingLifecycleError(params.runId);
    void notifyContextEngineSubagentEnded({
      childSessionKey: params.entry.childSessionKey,
      reason: "deleted",
      workspaceDir: params.entry.workspaceDir,
    });
    subagentRuns.delete(params.runId);
    persistSubagentRuns();
    retryDeferredCompletedAnnounces(params.runId);
    return;
  }
  void notifyContextEngineSubagentEnded({
    childSessionKey: params.entry.childSessionKey,
    reason: "completed",
    workspaceDir: params.entry.workspaceDir,
  });
  params.entry.cleanupCompletedAt = params.completedAt;
  persistSubagentRuns();
  retryDeferredCompletedAnnounces(params.runId);
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

function retryDeferredCompletedAnnounces(excludeRunId?: string) {
  const now = Date.now();
  for (const [runId, entry] of subagentRuns.entries()) {
    if (excludeRunId && runId === excludeRunId) {
      continue;
    }
    if (typeof entry.endedAt !== "number") {
      continue;
    }
    if (entry.cleanupCompletedAt || entry.cleanupHandled) {
      continue;
    }
    if (suppressAnnounceForSteerRestart(entry)) {
      continue;
    }
    // Force-expire stale non-completion announces; completion-message flows can
    // stay pending while descendants run for a long time.
    const endedAgo = now - (entry.endedAt ?? now);
    if (entry.expectsCompletionMessage !== true && endedAgo > ANNOUNCE_EXPIRY_MS) {
      if (!beginSubagentCleanup(runId)) {
        continue;
      }
      void finalizeResumedAnnounceGiveUp({
        runId,
        entry,
        reason: "expiry",
      }).catch((error) => {
        defaultRuntime.log(
          `[warn] Subagent expiry finalize failed during deferred retry for run ${runId}: ${String(error)}`,
        );
        const current = subagentRuns.get(runId);
        if (!current || current.cleanupCompletedAt) {
          return;
        }
        current.cleanupHandled = false;
        persistSubagentRuns();
      });
      continue;
    }
    resumedRuns.delete(runId);
    resumeSubagentRun(runId);
  }
}

function beginSubagentCleanup(runId: string) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return false;
  }
  if (entry.cleanupCompletedAt) {
    return false;
  }
  if (entry.cleanupHandled) {
    return false;
  }
  entry.cleanupHandled = true;
  persistSubagentRuns();
  return true;
}

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
