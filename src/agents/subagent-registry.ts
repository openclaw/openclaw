import { promises as fs } from "node:fs";
import path from "node:path";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
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
  SUBAGENT_ENDED_OUTCOME_KILLED,
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
import {
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type { SubagentRunRecord } from "./subagent-registry.types.js";
const log = createSubsystemLogger("agents/subagent-registry");

const subagentRuns = new Map<string, SubagentRunRecord>();
let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const MIN_ANNOUNCE_RETRY_DELAY_MS = 1_000;
const MAX_ANNOUNCE_RETRY_DELAY_MS = 8_000;
/**
 * Maximum number of announce delivery attempts before giving up.
 * Prevents infinite retry loops when `runSubagentAnnounceFlow` repeatedly
 * returns `false` due to stale state or transient conditions (#18264).
 */
const MAX_ANNOUNCE_RETRY_COUNT = 3;
/**
 * Non-completion announce entries older than this are force-expired even if
 * delivery never succeeded.
 */
const ANNOUNCE_EXPIRY_MS = 5 * 60_000; // 5 minutes
/**
 * Completion-message flows can wait for descendants to finish, but this hard
 * cap prevents indefinite pending state when descendants never fully settle.
 */
const ANNOUNCE_COMPLETION_HARD_EXPIRY_MS = 30 * 60_000; // 30 minutes
type SubagentRunOrphanReason = "missing-session-entry" | "missing-session-id";
/**
 * Embedded runs can emit transient lifecycle `error` events while provider/model
 * retry is still in progress. Defer terminal error cleanup briefly so a
 * subsequent lifecycle `start` / `end` can cancel premature failure announces.
 */
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;
const FROZEN_RESULT_TEXT_MAX_BYTES = 100 * 1024;

function capFrozenResultText(resultText: string): string {
  const trimmed = resultText.trim();
  if (!trimmed) {
    return "";
  }
  const totalBytes = Buffer.byteLength(trimmed, "utf8");
  if (totalBytes <= FROZEN_RESULT_TEXT_MAX_BYTES) {
    return trimmed;
  }
  const notice = `\n\n[truncated: frozen completion output exceeded ${Math.round(FROZEN_RESULT_TEXT_MAX_BYTES / 1024)}KB (${Math.round(totalBytes / 1024)}KB)]`;
  const maxPayloadBytes = Math.max(
    0,
    FROZEN_RESULT_TEXT_MAX_BYTES - Buffer.byteLength(notice, "utf8"),
  );
  const payload = Buffer.from(trimmed, "utf8").subarray(0, maxPayloadBytes).toString("utf8");
  return `${payload}${notice}`;
}

function resolveAnnounceRetryDelayMs(retryCount: number) {
  const boundedRetryCount = Math.max(0, Math.min(retryCount, 10));
  // retryCount is "attempts already made", so retry #1 waits 1s, then 2s, 4s...
  const backoffExponent = Math.max(0, boundedRetryCount - 1);
  const baseDelay = MIN_ANNOUNCE_RETRY_DELAY_MS * 2 ** backoffExponent;
  return Math.min(baseDelay, MAX_ANNOUNCE_RETRY_DELAY_MS);
}

function logAnnounceGiveUp(entry: SubagentRunRecord, reason: "retry-limit" | "expiry") {
  const retryCount = entry.announceRetryCount ?? 0;
  const endedAgoMs =
    typeof entry.endedAt === "number" ? Math.max(0, Date.now() - entry.endedAt) : undefined;
  const endedAgoLabel = endedAgoMs != null ? `${Math.round(endedAgoMs / 1000)}s` : "n/a";
  defaultRuntime.log(
    `[warn] Subagent announce give up (${reason}) run=${entry.runId} child=${entry.childSessionKey} requester=${entry.requesterSessionKey} retries=${retryCount} endedAgo=${endedAgoLabel}`,
  );
}

function persistSubagentRuns() {
  persistSubagentRunsToDisk(subagentRuns);
}

function findSessionEntryByKey(store: Record<string, SessionEntry>, sessionKey: string) {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = sessionKey.toLowerCase();
  for (const [key, entry] of Object.entries(store)) {
    if (key.toLowerCase() === normalized) {
      return entry;
    }
  }
  return undefined;
}

export function resolveSubagentSessionStatus(
  entry: Pick<SubagentRunRecord, "endedAt" | "endedReason" | "outcome"> | null | undefined,
): SessionEntry["status"] {
  if (!entry) {
    return undefined;
  }
  if (!entry.endedAt) {
    return "running";
  }
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  const status = entry.outcome?.status;
  if (status === "error") {
    return "failed";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "done";
}

async function persistSubagentSessionTiming(entry: SubagentRunRecord) {
  const childSessionKey = entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return;
  }

  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(childSessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const startedAt = getSubagentSessionStartedAt(entry);
  const endedAt =
    typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : undefined;
  const runtimeMs =
    endedAt !== undefined
      ? getSubagentSessionRuntimeMs(entry, endedAt)
      : getSubagentSessionRuntimeMs(entry);
  const status = resolveSubagentSessionStatus(entry);

  await updateSessionStore(storePath, (store) => {
    const sessionEntry = findSessionEntryByKey(store, childSessionKey);
    if (!sessionEntry) {
      return;
    }

    if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
      sessionEntry.startedAt = startedAt;
    } else {
      delete sessionEntry.startedAt;
    }

    if (typeof endedAt === "number" && Number.isFinite(endedAt)) {
      sessionEntry.endedAt = endedAt;
    } else {
      delete sessionEntry.endedAt;
    }

    if (typeof runtimeMs === "number" && Number.isFinite(runtimeMs)) {
      sessionEntry.runtimeMs = runtimeMs;
    } else {
      delete sessionEntry.runtimeMs;
    }

    if (status) {
      sessionEntry.status = status;
    } else {
      delete sessionEntry.status;
    }
  });
}

function resolveSubagentRunOrphanReason(params: {
  entry: SubagentRunRecord;
  storeCache?: Map<string, Record<string, SessionEntry>>;
}): SubagentRunOrphanReason | null {
  const childSessionKey = params.entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "missing-session-entry";
  }
  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(childSessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    let store = params.storeCache?.get(storePath);
    if (!store) {
      store = loadSessionStore(storePath);
      params.storeCache?.set(storePath, store);
    }
    const sessionEntry = findSessionEntryByKey(store, childSessionKey);
    if (!sessionEntry) {
      return "missing-session-entry";
    }
    if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
      return "missing-session-id";
    }
    return null;
  } catch {
    // Best-effort guard: avoid false orphan pruning on transient read/config failures.
    return null;
  }
}

function reconcileOrphanedRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  reason: SubagentRunOrphanReason;
  source: "restore" | "resume";
}) {
  const now = Date.now();
  let changed = false;
  if (typeof params.entry.endedAt !== "number") {
    params.entry.endedAt = now;
    changed = true;
  }
  const orphanOutcome: SubagentRunOutcome = {
    status: "error",
    error: `orphaned subagent run (${params.reason})`,
  };
  if (!runOutcomesEqual(params.entry.outcome, orphanOutcome)) {
    params.entry.outcome = orphanOutcome;
    changed = true;
  }
  if (params.entry.endedReason !== SUBAGENT_ENDED_REASON_ERROR) {
    params.entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    changed = true;
  }
  if (params.entry.cleanupHandled !== true) {
    params.entry.cleanupHandled = true;
    changed = true;
  }
  if (typeof params.entry.cleanupCompletedAt !== "number") {
    params.entry.cleanupCompletedAt = now;
    changed = true;
  }
  const removed = subagentRuns.delete(params.runId);
  resumedRuns.delete(params.runId);
  if (!removed && !changed) {
    return false;
  }
  defaultRuntime.log(
    `[warn] Subagent orphan run pruned source=${params.source} run=${params.runId} child=${params.entry.childSessionKey} reason=${params.reason}`,
  );
  return true;
}

function reconcileOrphanedRestoredRuns() {
  const storeCache = new Map<string, Record<string, SessionEntry>>();
  let changed = false;
  for (const [runId, entry] of subagentRuns.entries()) {
    const orphanReason = resolveSubagentRunOrphanReason({
      entry,
      storeCache,
    });
    if (!orphanReason) {
      continue;
    }
    if (
      reconcileOrphanedRun({
        runId,
        entry,
        reason: orphanReason,
        source: "restore",
      })
    ) {
      changed = true;
    }
  }
  return changed;
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

/**
 * Send an external completion notification to a configured channel when
 * `notifyChannel` and `notifyTarget` are set on the run record.
 * This is fire-and-forget; failures are logged but do not block cleanup.
 */
async function sendExternalCompletionNotification(entry: SubagentRunRecord): Promise<void> {
  const channel = entry.notifyChannel?.trim();
  const target = entry.notifyTarget?.trim();
  if (!channel || !target) {
    return;
  }
  const normalizedRequesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
  const normalizedNotifyChannel = normalizeDeliveryContext({ channel })?.channel ?? channel;
  const accountId =
    normalizedRequesterOrigin?.channel === normalizedNotifyChannel
      ? normalizedRequesterOrigin.accountId
      : undefined;

  const taskLabel = entry.label || entry.task || "task";
  const outcome = entry.outcome;
  const statusEmoji =
    outcome?.status === "error" ? "❌" : outcome?.status === "timeout" ? "⏱️" : "✅";
  const statusText =
    outcome?.status === "error"
      ? "failed"
      : outcome?.status === "timeout"
        ? "timed out"
        : "completed";

  const message = `${statusEmoji} Subagent "${taskLabel}" ${statusText}`;

  try {
    await callGateway({
      method: "send",
      params: {
        channel,
        to: target,
        message,
        accountId,
        idempotencyKey: `subagent-complete-${entry.runId}`,
      },
      timeoutMs: 15_000,
    });
  } catch (err) {
    defaultRuntime.log(
      `[warn] External completion notification failed for run ${entry.runId} → ${channel}:${target}: ${String(err)}`,
    );
  }
}

function startSubagentAnnounceCleanupFlow(runId: string, entry: SubagentRunRecord): boolean {
  if (!beginSubagentCleanup(runId)) {
    return false;
  }
  const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
  const finalizeAnnounceCleanup = (didAnnounce: boolean) => {
    void finalizeSubagentCleanup(runId, entry.cleanup, {
      didAnnounce,
      wokeContinuation,
    }).catch((err) => {
      defaultRuntime.log(`[warn] subagent cleanup finalize failed (${runId}): ${String(err)}`);
      const current = subagentRuns.get(runId);
      if (!current || current.cleanupCompletedAt) {
        return;
      }
      current.cleanupHandled = false;
      persistSubagentRuns();
    });
  };
  let wokeContinuation = false;
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
    onWakeContinuationStarted: () => {
      wokeContinuation = true;
    },
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
    logAnnounceGiveUp(entry, "retry-limit");
    entry.cleanupCompletedAt = Date.now();
    persistSubagentRuns();
    return;
  }
  if (
    entry.expectsCompletionMessage !== true &&
    typeof entry.endedAt === "number" &&
    Date.now() - entry.endedAt > ANNOUNCE_EXPIRY_MS
  ) {
    logAnnounceGiveUp(entry, "expiry");
    entry.cleanupCompletedAt = Date.now();
    persistSubagentRuns();
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
  void waitForSubagentCompletion(runId, waitTimeoutMs);
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
    if (reconcileOrphanedRestoredRuns()) {
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

function resolveArchiveAfterMs(cfg?: ReturnType<typeof loadConfig>) {
  const config = cfg ?? loadConfig();
  const minutes = config.agents?.defaults?.subagents?.archiveAfterMinutes ?? 60;
  if (!Number.isFinite(minutes) || minutes < 0) {
    return undefined;
  }
  if (minutes === 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(minutes)) * 60_000;
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

async function safeRemoveAttachmentsDir(entry: SubagentRunRecord): Promise<void> {
  if (!entry.attachmentsDir || !entry.attachmentsRootDir) {
    return;
  }

  const resolveReal = async (targetPath: string): Promise<string | null> => {
    try {
      return await fs.realpath(targetPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        return null;
      }
      throw err;
    }
  };

  try {
    const [rootReal, dirReal] = await Promise.all([
      resolveReal(entry.attachmentsRootDir),
      resolveReal(entry.attachmentsDir),
    ]);
    if (!dirReal) {
      return;
    }

    const rootBase = rootReal ?? path.resolve(entry.attachmentsRootDir);
    // dirReal is guaranteed non-null here (early return above handles null case).
    const dirBase = dirReal;
    const rootWithSep = rootBase.endsWith(path.sep) ? rootBase : `${rootBase}${path.sep}`;
    if (!dirBase.startsWith(rootWithSep)) {
      return;
    }
    await fs.rm(dirBase, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

async function finalizeSubagentCleanup(
  runId: string,
  cleanup: "delete" | "keep",
  announceResult: { didAnnounce: boolean; wokeContinuation: boolean },
) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (announceResult.didAnnounce) {
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
    // Wake continuations hand completion delivery off to the replacement run.
    if (!announceResult.wokeContinuation) {
      void sendExternalCompletionNotification(entry);
    }
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
      cleanup: "keep",
      completedAt: now,
    });
    void sendExternalCompletionNotification(entry);
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
      logAnnounceGiveUp(entry, "expiry");
      entry.cleanupCompletedAt = now;
      persistSubagentRuns();
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
  const key = runId.trim();
  if (!key) {
    return false;
  }
  const entry = subagentRuns.get(key);
  if (!entry) {
    return false;
  }
  if (entry.suppressAnnounceReason === "steer-restart") {
    return true;
  }
  entry.suppressAnnounceReason = "steer-restart";
  persistSubagentRuns();
  return true;
}

export function clearSubagentRunSteerRestart(runId: string) {
  const key = runId.trim();
  if (!key) {
    return false;
  }
  const entry = subagentRuns.get(key);
  if (!entry) {
    return false;
  }
  if (entry.suppressAnnounceReason !== "steer-restart") {
    return true;
  }
  entry.suppressAnnounceReason = undefined;
  persistSubagentRuns();
  // If the interrupted run already finished while suppression was active, retry
  // cleanup now so completion output is not lost when restart dispatch fails.
  resumedRuns.delete(key);
  if (typeof entry.endedAt === "number" && !entry.cleanupCompletedAt) {
    resumeSubagentRun(key);
  }
  return true;
}

function resolveSubagentSessionStartedAt(
  entry: Pick<SubagentRunRecord, "sessionStartedAt" | "startedAt" | "createdAt">,
): number | undefined {
  if (typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)) {
    return entry.sessionStartedAt;
  }
  if (typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)) {
    return entry.startedAt;
  }
  return typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
    ? entry.createdAt
    : undefined;
}

export function getSubagentSessionStartedAt(
  entry: Pick<SubagentRunRecord, "sessionStartedAt" | "startedAt" | "createdAt"> | null | undefined,
): number | undefined {
  return entry ? resolveSubagentSessionStartedAt(entry) : undefined;
}

export function getSubagentSessionRuntimeMs(
  entry:
    | Pick<SubagentRunRecord, "startedAt" | "endedAt" | "accumulatedRuntimeMs">
    | null
    | undefined,
  now = Date.now(),
): number | undefined {
  if (!entry) {
    return undefined;
  }

  const accumulatedRuntimeMs =
    typeof entry.accumulatedRuntimeMs === "number" && Number.isFinite(entry.accumulatedRuntimeMs)
      ? Math.max(0, entry.accumulatedRuntimeMs)
      : 0;

  if (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)) {
    return entry.accumulatedRuntimeMs != null ? accumulatedRuntimeMs : undefined;
  }

  const currentRunEndedAt =
    typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : now;
  return Math.max(0, accumulatedRuntimeMs + Math.max(0, currentRunEndedAt - entry.startedAt));
}

export function replaceSubagentRunAfterSteer(params: {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
}) {
  const previousRunId = params.previousRunId.trim();
  const nextRunId = params.nextRunId.trim();
  if (!previousRunId || !nextRunId) {
    return false;
  }

  const previous = subagentRuns.get(previousRunId);
  const source = previous ?? params.fallback;
  if (!source) {
    return false;
  }

  if (previousRunId !== nextRunId) {
    clearPendingLifecycleError(previousRunId);
    subagentRuns.delete(previousRunId);
    resumedRuns.delete(previousRunId);
  }

  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const spawnMode = source.spawnMode === "session" ? "session" : "run";
  const archiveAtMs =
    spawnMode === "session" || source.cleanup === "keep"
      ? undefined
      : archiveAfterMs
        ? now + archiveAfterMs
        : undefined;
  const runTimeoutSeconds = params.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
  const preserveFrozenResultFallback = params.preserveFrozenResultFallback === true;
  const sessionStartedAt = resolveSubagentSessionStartedAt(source) ?? now;
  const accumulatedRuntimeMs =
    getSubagentSessionRuntimeMs(
      source,
      typeof source.endedAt === "number" ? source.endedAt : now,
    ) ?? 0;

  const next: SubagentRunRecord = {
    ...source,
    runId: nextRunId,
    createdAt: now,
    startedAt: now,
    sessionStartedAt,
    accumulatedRuntimeMs,
    endedAt: undefined,
    endedReason: undefined,
    endedHookEmittedAt: undefined,
    wakeOnDescendantSettle: undefined,
    outcome: undefined,
    frozenResultText: undefined,
    frozenResultCapturedAt: undefined,
    fallbackFrozenResultText: preserveFrozenResultFallback ? source.frozenResultText : undefined,
    fallbackFrozenResultCapturedAt: preserveFrozenResultFallback
      ? source.frozenResultCapturedAt
      : undefined,
    cleanupCompletedAt: undefined,
    cleanupHandled: false,
    suppressAnnounceReason: undefined,
    announceRetryCount: undefined,
    lastAnnounceRetryAt: undefined,
    spawnMode,
    archiveAtMs,
    runTimeoutSeconds,
  };

  subagentRuns.set(nextRunId, next);
  ensureListener();
  persistSubagentRuns();
  if (archiveAtMs) {
    startSweeper();
  }
  void waitForSubagentCompletion(nextRunId, waitTimeoutMs);
  return true;
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
  notifyChannel?: string;
  notifyTarget?: string;
}) {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const spawnMode = params.spawnMode === "session" ? "session" : "run";
  const archiveAtMs =
    spawnMode === "session" || params.cleanup === "keep"
      ? undefined
      : archiveAfterMs
        ? now + archiveAfterMs
        : undefined;
  const runTimeoutSeconds = params.runTimeoutSeconds ?? 0;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  subagentRuns.set(params.runId, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    controllerSessionKey: params.controllerSessionKey ?? params.requesterSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    expectsCompletionMessage: params.expectsCompletionMessage,
    spawnMode,
    label: params.label,
    model: params.model,
    workspaceDir: params.workspaceDir,
    runTimeoutSeconds,
    createdAt: now,
    startedAt: now,
    sessionStartedAt: now,
    accumulatedRuntimeMs: 0,
    archiveAtMs,
    cleanupHandled: false,
    wakeOnDescendantSettle: undefined,
    attachmentsDir: params.attachmentsDir,
    attachmentsRootDir: params.attachmentsRootDir,
    retainAttachmentsOnKeep: params.retainAttachmentsOnKeep,
    notifyChannel: params.notifyChannel,
    notifyTarget: params.notifyTarget,
  });
  ensureListener();
  persistSubagentRuns();
  if (archiveAtMs) {
    startSweeper();
  }
  // Wait for subagent completion via gateway RPC (cross-process).
  // The in-process lifecycle listener is a fallback for embedded runs.
  void waitForSubagentCompletion(params.runId, waitTimeoutMs);
}

async function waitForSubagentCompletion(runId: string, waitTimeoutMs: number) {
  try {
    const timeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
    const wait = await callGateway<{
      status?: string;
      startedAt?: number;
      endedAt?: number;
      error?: string;
    }>({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 10_000,
    });
    if (wait?.status !== "ok" && wait?.status !== "error" && wait?.status !== "timeout") {
      return;
    }
    const entry = subagentRuns.get(runId);
    if (!entry) {
      return;
    }
    let mutated = false;
    if (typeof wait.startedAt === "number") {
      entry.startedAt = wait.startedAt;
      if (typeof entry.sessionStartedAt !== "number") {
        entry.sessionStartedAt = wait.startedAt;
      }
      mutated = true;
    }
    if (typeof wait.endedAt === "number") {
      entry.endedAt = wait.endedAt;
      mutated = true;
    }
    if (!entry.endedAt) {
      entry.endedAt = Date.now();
      mutated = true;
    }
    const waitError = typeof wait.error === "string" ? wait.error : undefined;
    const outcome: SubagentRunOutcome =
      wait.status === "error"
        ? { status: "error", error: waitError }
        : wait.status === "timeout"
          ? { status: "timeout" }
          : { status: "ok" };
    if (!runOutcomesEqual(entry.outcome, outcome)) {
      entry.outcome = outcome;
      mutated = true;
    }
    if (mutated) {
      persistSubagentRuns();
    }
    await completeSubagentRun({
      runId,
      endedAt: entry.endedAt,
      outcome,
      reason:
        wait.status === "error" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    });
  } catch {
    // ignore
  }
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
  clearPendingLifecycleError(runId);
  const entry = subagentRuns.get(runId);
  if (entry) {
    void notifyContextEngineSubagentEnded({
      childSessionKey: entry.childSessionKey,
      reason: "released",
      workspaceDir: entry.workspaceDir,
    });
  }
  const didDelete = subagentRuns.delete(runId);
  if (didDelete) {
    persistSubagentRuns();
  }
  if (subagentRuns.size === 0) {
    stopSweeper();
  }
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
  for (const runId of runIds) {
    const entry = subagentRuns.get(runId);
    if (!entry) {
      continue;
    }
    if (typeof entry.endedAt !== "number") {
      return true;
    }
  }
  return false;
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
  const runIds = new Set<string>();
  if (typeof params.runId === "string" && params.runId.trim()) {
    runIds.add(params.runId.trim());
  }
  if (typeof params.childSessionKey === "string" && params.childSessionKey.trim()) {
    for (const runId of findRunIdsByChildSessionKey(params.childSessionKey)) {
      runIds.add(runId);
    }
  }
  if (runIds.size === 0) {
    return 0;
  }

  const now = Date.now();
  const reason = params.reason?.trim() || "killed";
  let updated = 0;
  const entriesByChildSessionKey = new Map<string, SubagentRunRecord>();
  for (const runId of runIds) {
    clearPendingLifecycleError(runId);
    const entry = subagentRuns.get(runId);
    if (!entry) {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      continue;
    }
    entry.endedAt = now;
    entry.outcome = { status: "error", error: reason };
    entry.endedReason = SUBAGENT_ENDED_REASON_KILLED;
    entry.cleanupHandled = true;
    entry.cleanupCompletedAt = now;
    entry.suppressAnnounceReason = "killed";
    if (!entriesByChildSessionKey.has(entry.childSessionKey)) {
      entriesByChildSessionKey.set(entry.childSessionKey, entry);
    }
    updated += 1;
  }
  if (updated > 0) {
    persistSubagentRuns();
    for (const entry of entriesByChildSessionKey.values()) {
      void persistSubagentSessionTiming(entry).catch((err) => {
        log.warn("failed to persist killed subagent session timing", {
          err,
          runId: entry.runId,
          childSessionKey: entry.childSessionKey,
        });
      });
      void emitSubagentEndedHookOnce({
        entry,
        reason: SUBAGENT_ENDED_REASON_KILLED,
        sendFarewell: true,
        outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
        error: reason,
        inFlightRunIds: endedHookInFlightRunIds,
        persist: persistSubagentRuns,
      }).catch(() => {
        // Hook failures should not break termination flow.
      });
    }
  }
  return updated;
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

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}
