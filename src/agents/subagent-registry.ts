import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";
import { runSubagentAnnounceFlow, type SubagentRunOutcome } from "./subagent-announce.js";
import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  runTimeoutSeconds?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
};

const subagentRuns = new Map<string, SubagentRunRecord>();
let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;

function persistSubagentRuns() {
  try {
    saveSubagentRegistryToDisk(subagentRuns);
  } catch {
    // ignore persistence failures
  }
}

const resumedRuns = new Set<string>();

function suppressAnnounceForSteerRestart(entry?: SubagentRunRecord) {
  return entry?.suppressAnnounceReason === "steer-restart";
}

function startSubagentAnnounceCleanupFlow(runId: string, entry: SubagentRunRecord): boolean {
  if (!beginSubagentCleanup(runId)) {
    return false;
  }
  const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
  void runSubagentAnnounceFlow({
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    requesterSessionKey: entry.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: entry.requesterDisplayKey,
    task: entry.task,
    timeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
    cleanup: entry.cleanup,
    waitForCompletion: false,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    label: entry.label,
    outcome: entry.outcome,
  }).then((didAnnounce) => {
    finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
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
  if (entry.cleanupCompletedAt) {
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
    const restored = loadSubagentRegistryFromDisk();
    if (restored.size === 0) {
      return;
    }
    for (const [runId, entry] of restored.entries()) {
      if (!runId || !entry) {
        continue;
      }
      // Keep any newer in-memory entries.
      if (!subagentRuns.has(runId)) {
        subagentRuns.set(runId, entry);
      }
    }

    // Resume pending work.
    ensureListener();
    if ([...subagentRuns.values()].some((entry) => entry.archiveAtMs)) {
      startSweeper();
    }
    for (const runId of subagentRuns.keys()) {
      resumeSubagentRun(runId);
    }
  } catch {
    // ignore restore failures
  }
}

function resolveArchiveAfterMs(cfg?: ReturnType<typeof loadConfig>) {
  const config = cfg ?? loadConfig();
  const minutes = config.agents?.defaults?.subagents?.archiveAfterMinutes ?? 60;
  if (!Number.isFinite(minutes) || minutes <= 0) {
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
    subagentRuns.delete(runId);
    mutated = true;
    try {
      await callGateway({
        method: "sessions.delete",
        params: { key: entry.childSessionKey, deleteTranscript: true },
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
    if (!evt || evt.stream !== "lifecycle") {
      return;
    }
    const entry = subagentRuns.get(evt.runId);
    if (!entry) {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      if (startedAt) {
        entry.startedAt = startedAt;
        persistSubagentRuns();
      }
      return;
    }
    if (phase !== "end" && phase !== "error") {
      return;
    }
    const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
    entry.endedAt = endedAt;
    if (phase === "error") {
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      entry.outcome = { status: "error", error };
    } else if (evt.data?.aborted) {
      entry.outcome = { status: "timeout" };
    } else {
      entry.outcome = { status: "ok" };
    }
    persistSubagentRuns();

    if (suppressAnnounceForSteerRestart(entry)) {
      return;
    }

    if (!startSubagentAnnounceCleanupFlow(evt.runId, entry)) {
      return;
    }
  });
}

function finalizeSubagentCleanup(runId: string, cleanup: "delete" | "keep", didAnnounce: boolean) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (!didAnnounce) {
    // Allow retry on the next wake if announce was deferred or failed.
    entry.cleanupHandled = false;
    resumedRuns.delete(runId);
    persistSubagentRuns();
    return;
  }
  if (cleanup === "delete") {
    subagentRuns.delete(runId);
    persistSubagentRuns();
    retryDeferredCompletedAnnounces(runId);
    return;
  }
  entry.cleanupCompletedAt = Date.now();
  persistSubagentRuns();
  retryDeferredCompletedAnnounces(runId);
}

function retryDeferredCompletedAnnounces(excludeRunId?: string) {
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

export function replaceSubagentRunAfterSteer(params: {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
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
    subagentRuns.delete(previousRunId);
    resumedRuns.delete(previousRunId);
  }

  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  const runTimeoutSeconds = params.runTimeoutSeconds ?? source.runTimeoutSeconds ?? 0;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);

  const next: SubagentRunRecord = {
    ...source,
    runId: nextRunId,
    startedAt: now,
    endedAt: undefined,
    outcome: undefined,
    cleanupCompletedAt: undefined,
    cleanupHandled: false,
    suppressAnnounceReason: undefined,
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
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  runTimeoutSeconds?: number;
}) {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  const runTimeoutSeconds = params.runTimeoutSeconds ?? 0;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  subagentRuns.set(params.runId, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    label: params.label,
    model: params.model,
    runTimeoutSeconds,
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    cleanupHandled: false,
  });
  ensureListener();
  persistSubagentRuns();
  if (archiveAfterMs) {
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
    entry.outcome =
      wait.status === "error"
        ? { status: "error", error: waitError }
        : wait.status === "timeout"
          ? { status: "timeout" }
          : { status: "ok" };
    mutated = true;
    if (mutated) {
      persistSubagentRuns();
    }
    if (suppressAnnounceForSteerRestart(entry)) {
      return;
    }
    if (!startSubagentAnnounceCleanupFlow(runId, entry)) {
      return;
    }
  } catch {
    // ignore
  }
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  subagentRuns.clear();
  resumedRuns.clear();
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
  const didDelete = subagentRuns.delete(runId);
  if (didDelete) {
    persistSubagentRuns();
  }
  if (subagentRuns.size === 0) {
    stopSweeper();
  }
}

function findRunIdsByChildSessionKey(childSessionKey: string): string[] {
  const key = childSessionKey.trim();
  if (!key) {
    return [];
  }
  const runIds: string[] = [];
  for (const [runId, entry] of subagentRuns.entries()) {
    if (entry.childSessionKey === key) {
      runIds.push(runId);
    }
  }
  return runIds;
}

function getRunsSnapshotForRead(): Map<string, SubagentRunRecord> {
  const merged = new Map<string, SubagentRunRecord>();
  const shouldReadDisk = !(process.env.VITEST || process.env.NODE_ENV === "test");
  if (shouldReadDisk) {
    try {
      // Registry state is persisted to disk so other worker processes (for
      // example cron runners) can observe active children spawned elsewhere.
      for (const [runId, entry] of loadSubagentRegistryFromDisk().entries()) {
        merged.set(runId, entry);
      }
    } catch {
      // Ignore disk read failures and fall back to local memory state.
    }
  }
  for (const [runId, entry] of subagentRuns.entries()) {
    merged.set(runId, entry);
  }
  return merged;
}

export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }
  let best: SubagentRunRecord | undefined;
  for (const entry of getRunsSnapshotForRead().values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!best || entry.createdAt > best.createdAt) {
      best = entry;
    }
  }
  if (!best) {
    return null;
  }
  return {
    requesterSessionKey: best.requesterSessionKey,
    requesterOrigin: normalizeDeliveryContext(best.requesterOrigin),
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
  for (const runId of runIds) {
    const entry = subagentRuns.get(runId);
    if (!entry) {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      continue;
    }
    entry.endedAt = now;
    entry.outcome = { status: "error", error: reason };
    entry.cleanupHandled = true;
    entry.cleanupCompletedAt = now;
    entry.suppressAnnounceReason = "killed";
    updated += 1;
  }
  if (updated > 0) {
    persistSubagentRuns();
  }
  return updated;
}

export function listSubagentRunsForRequester(requesterSessionKey: string): SubagentRunRecord[] {
  const key = requesterSessionKey.trim();
  if (!key) {
    return [];
  }
  return [...subagentRuns.values()].filter((entry) => entry.requesterSessionKey === key);
}

export function countActiveRunsForSession(requesterSessionKey: string): number {
  const key = requesterSessionKey.trim();
  if (!key) {
    return 0;
  }
  let count = 0;
  for (const entry of getRunsSnapshotForRead().values()) {
    if (entry.requesterSessionKey !== key) {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      continue;
    }
    count += 1;
  }
  return count;
}

export function countActiveDescendantRuns(rootSessionKey: string): number {
  const root = rootSessionKey.trim();
  if (!root) {
    return 0;
  }
  const runs = getRunsSnapshotForRead();
  const pending = [root];
  const visited = new Set<string>([root]);
  let count = 0;
  while (pending.length > 0) {
    const requester = pending.shift();
    if (!requester) {
      continue;
    }
    for (const entry of runs.values()) {
      if (entry.requesterSessionKey !== requester) {
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        count += 1;
      }
      const childKey = entry.childSessionKey.trim();
      if (!childKey || visited.has(childKey)) {
        continue;
      }
      visited.add(childKey);
      pending.push(childKey);
    }
  }
  return count;
}

export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  const root = rootSessionKey.trim();
  if (!root) {
    return [];
  }
  const runs = getRunsSnapshotForRead();
  const pending = [root];
  const visited = new Set<string>([root]);
  const descendants: SubagentRunRecord[] = [];
  while (pending.length > 0) {
    const requester = pending.shift();
    if (!requester) {
      continue;
    }
    for (const entry of runs.values()) {
      if (entry.requesterSessionKey !== requester) {
        continue;
      }
      descendants.push(entry);
      const childKey = entry.childSessionKey.trim();
      if (!childKey || visited.has(childKey)) {
        continue;
      }
      visited.add(childKey);
      pending.push(childKey);
    }
  }
  return descendants;
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}
