import crypto from "node:crypto";
import type { CompletionReport } from "./completion-report-parser.js";
import type { VerificationContract, VerificationResult } from "./spawn-verification.types.js";
import { normalizeSubagentProviderLimitKey } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { recordAgentPerformance, type AgentPerformanceOutcome } from "./performance-tracker.js";
import { runSubagentAnnounceFlow, type SubagentRunOutcome } from "./subagent-announce.js";
import { cleanupProgressFileForRun, type SubagentLatestProgress } from "./subagent-progress.js";
import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type OriginalSpawnParams = {
  label?: string;
  requestedAgentId?: string;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  explicitRunTimeoutSeconds?: number;
  completionReport?: boolean;
  progressReporting?: boolean;
  requesterAgentIdOverride?: string;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  toolOverrides?: {
    allow?: string[];
    deny?: string[];
  };
  verification?: VerificationContract;
};

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  depth?: number;
  provider?: string;
  childKeys?: Set<string>;
  completionReport?: CompletionReport;
  latestProgress?: SubagentLatestProgress;
  verification?: VerificationContract;
  verificationResult?: VerificationResult;
  verificationState?: "pending" | "running" | "passed" | "failed";
  retryAttemptedAt?: number;
  originalSpawnParams?: OriginalSpawnParams;
};

const subagentRuns = new Map<string, SubagentRunRecord>();
const cleanupInProgress = new Set<string>();
const log = createSubsystemLogger("agents/subagent-registry");
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

export function getRunByChildKey(childKey: string): SubagentRunRecord | undefined {
  restoreSubagentRunsOnce();
  for (const entry of subagentRuns.values()) {
    if (entry.childSessionKey === childKey) {
      return entry;
    }
  }
  return undefined;
}

export function getActiveChildCount(parentKey: string): number {
  restoreSubagentRunsOnce();
  let count = 0;
  for (const entry of subagentRuns.values()) {
    if (entry.requesterSessionKey === parentKey && !entry.endedAt) {
      count++;
    }
  }
  return count;
}

export function listAllSubagentRuns(): SubagentRunRecord[] {
  restoreSubagentRunsOnce();
  return [...subagentRuns.values()];
}

const pendingSpawns = new Map<string, number>();
const pendingProviderSpawns = new Map<string, Set<string>>();

export type ProviderSlotReservation = {
  provider: string;
  token: string;
};

function normalizeProviderKey(provider: string): string {
  return normalizeSubagentProviderLimitKey(provider) ?? "";
}

function getActiveProviderCount(provider: string): number {
  restoreSubagentRunsOnce();
  let count = 0;
  for (const entry of subagentRuns.values()) {
    if (entry.endedAt) {
      continue;
    }
    if (normalizeProviderKey(entry.provider ?? "") === provider) {
      count += 1;
    }
  }
  return count;
}

export function getProviderUsage(provider: string): {
  active: number;
  pending: number;
  total: number;
} {
  restoreSubagentRunsOnce();
  const providerKey = normalizeProviderKey(provider);
  if (!providerKey) {
    return { active: 0, pending: 0, total: 0 };
  }
  const active = getActiveProviderCount(providerKey);
  const pending = pendingProviderSpawns.get(providerKey)?.size ?? 0;
  return {
    active,
    pending,
    total: active + pending,
  };
}

export function reserveProviderSlot(provider: string, max: number): ProviderSlotReservation | null {
  restoreSubagentRunsOnce();
  const providerKey = normalizeProviderKey(provider);
  if (!providerKey) {
    return null;
  }

  const usage = getProviderUsage(providerKey);
  if (usage.total >= max) {
    return null;
  }

  const token = crypto.randomUUID();
  const pending = pendingProviderSpawns.get(providerKey) ?? new Set<string>();
  pending.add(token);
  pendingProviderSpawns.set(providerKey, pending);
  return {
    provider: providerKey,
    token,
  };
}

export function releaseProviderSlot(reservation?: ProviderSlotReservation | null): void {
  const providerKey = normalizeProviderKey(reservation?.provider ?? "");
  const token = reservation?.token?.trim();
  if (!providerKey || !token) {
    return;
  }

  const pending = pendingProviderSpawns.get(providerKey);
  if (!pending) {
    return;
  }
  pending.delete(token);
  if (pending.size === 0) {
    pendingProviderSpawns.delete(providerKey);
  }
}

export function reserveChildSlot(parentKey: string, max: number): boolean {
  restoreSubagentRunsOnce();
  const active = getActiveChildCount(parentKey);
  const pending = pendingSpawns.get(parentKey) ?? 0;
  if (active + pending >= max) {
    return false;
  }
  pendingSpawns.set(parentKey, pending + 1);
  return true;
}

export function releaseChildSlot(parentKey: string): void {
  const pending = pendingSpawns.get(parentKey) ?? 0;
  if (pending > 0) {
    const next = pending - 1;
    if (next > 0) {
      pendingSpawns.set(parentKey, next);
    } else {
      pendingSpawns.delete(parentKey);
    }
  }
}

const resumedRuns = new Set<string>();

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
    // Older registry snapshots could mark handled before announce completion.
    // Keep these runs retryable on restore.
    if (entry.cleanupHandled && !entry.cleanupCompletedAt) {
      entry.cleanupHandled = false;
      persistSubagentRuns();
    }
    if (!beginSubagentCleanup(runId)) {
      return;
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
    })
      .then((didAnnounce) => {
        finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
      })
      .catch(() => {
        finalizeSubagentCleanup(runId, entry.cleanup, false);
      });
    resumedRuns.add(runId);
    return;
  }

  // Wait for completion again after restart.
  const cfg = loadConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, undefined);
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
  return resolveAgentTimeoutMs({ cfg, overrideSeconds: runTimeoutSeconds });
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
    cleanupInProgress.delete(runId);
    resumedRuns.delete(runId);
    mutated = true;
    try {
      await cleanupProgressFileForRun(runId);
    } catch {
      // ignore
    }
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

    if (!beginSubagentCleanup(evt.runId)) {
      return;
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
    })
      .then((didAnnounce) => {
        finalizeSubagentCleanup(evt.runId, entry.cleanup, didAnnounce);
      })
      .catch(() => {
        finalizeSubagentCleanup(evt.runId, entry.cleanup, false);
      });
  });
}

function resolvePerformanceOutcome(entry: SubagentRunRecord): AgentPerformanceOutcome {
  const status = entry.outcome?.status;
  if (status === "timeout") {
    return "timeout";
  }
  if (status === "error") {
    return "failure";
  }
  if (entry.verificationState === "failed") {
    return "partial";
  }
  return "success";
}

function resolveVerificationPassed(entry: SubagentRunRecord): boolean | undefined {
  const status = entry.verificationResult?.status;
  if (status === "passed") {
    return true;
  }
  if (status === "failed") {
    return false;
  }
  return undefined;
}

function resolveRunTokens(childSessionKey: string): {
  inputTokens?: number | null;
  outputTokens?: number | null;
} {
  const cfg = loadConfig();
  const agentId = resolveAgentIdFromSessionKey(childSessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const sessionEntry = store[childSessionKey];
  const inputTokens =
    typeof sessionEntry?.inputTokens === "number" ? sessionEntry.inputTokens : undefined;
  const outputTokens =
    typeof sessionEntry?.outputTokens === "number" ? sessionEntry.outputTokens : undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

async function recordSubagentPerformance(entry: SubagentRunRecord): Promise<void> {
  const agentId = resolveAgentIdFromSessionKey(entry.childSessionKey);
  const endedAt = typeof entry.endedAt === "number" ? entry.endedAt : Date.now();
  const startedAt =
    typeof entry.startedAt === "number"
      ? entry.startedAt
      : typeof entry.createdAt === "number"
        ? entry.createdAt
        : endedAt;
  const runtimeMs = Math.max(0, endedAt - startedAt);
  const completionReport = entry.completionReport
    ? {
        status: entry.completionReport.status,
        confidence: entry.completionReport.confidence,
      }
    : undefined;
  const tokens = resolveRunTokens(entry.childSessionKey);

  await recordAgentPerformance({
    runId: entry.runId,
    agentId,
    taskType: entry.label ?? "subagent",
    spawnerSessionKey: entry.requesterSessionKey,
    startedAt,
    endedAt,
    runtimeMs,
    outcome: resolvePerformanceOutcome(entry),
    verificationPassed: resolveVerificationPassed(entry),
    completionReport,
    ...tokens,
  });
}

function finalizeSubagentCleanup(runId: string, cleanup: "delete" | "keep", didAnnounce: boolean) {
  cleanupInProgress.delete(runId);
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (!didAnnounce) {
    // Allow retry on the next wake if announce was deferred or failed.
    entry.cleanupHandled = false;
    persistSubagentRuns();
    return;
  }
  void recordSubagentPerformance(entry).catch((err) => {
    log.warn(`failed to record subagent performance for run ${runId}: ${String(err)}`);
  });
  if (cleanup === "delete") {
    subagentRuns.delete(runId);
    persistSubagentRuns();
    void cleanupProgressFileForRun(runId).catch(() => {});
    return;
  }
  entry.cleanupHandled = true;
  entry.cleanupCompletedAt = Date.now();
  persistSubagentRuns();
}

function beginSubagentCleanup(runId: string) {
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return false;
  }
  if (entry.cleanupCompletedAt) {
    return false;
  }
  if (cleanupInProgress.has(runId)) {
    return false;
  }
  if (entry.cleanupHandled) {
    return false;
  }
  cleanupInProgress.add(runId);
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
  runTimeoutSeconds?: number;
  depth?: number;
  provider?: string;
  providerReservation?: ProviderSlotReservation | null;
  verification?: VerificationContract;
  originalSpawnParams?: OriginalSpawnParams;
}) {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, params.runTimeoutSeconds);
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const provider = normalizeProviderKey(
    params.provider ?? params.providerReservation?.provider ?? "",
  );
  subagentRuns.set(params.runId, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    label: params.label,
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    cleanupHandled: false,
    depth: params.depth ?? 1,
    provider: provider || undefined,
    childKeys: new Set(),
    verification: params.verification,
    verificationState: params.verification ? "pending" : undefined,
    originalSpawnParams: params.originalSpawnParams,
  });
  const parentRun = getRunByChildKey(params.requesterSessionKey);
  if (parentRun) {
    if (!parentRun.childKeys) {
      parentRun.childKeys = new Set();
    }
    parentRun.childKeys.add(params.childSessionKey);
  }
  releaseChildSlot(params.requesterSessionKey);
  releaseProviderSlot(params.providerReservation);
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
    if (!beginSubagentCleanup(runId)) {
      return;
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
    })
      .then((didAnnounce) => {
        finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
      })
      .catch(() => {
        finalizeSubagentCleanup(runId, entry.cleanup, false);
      });
  } catch {
    // ignore
  }
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  subagentRuns.clear();
  cleanupInProgress.clear();
  resumedRuns.clear();
  pendingSpawns.clear();
  pendingProviderSpawns.clear();
  stopSweeper();
  restoreAttempted = false;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  try {
    const { setRegistryAccessor } = require("../sessions/session-key-utils.js") as {
      setRegistryAccessor?: (
        fn: ((key: string) => SubagentRunRecord | undefined) | undefined,
      ) => void;
    };
    setRegistryAccessor?.(undefined);
  } catch {
    // ignore when session-key-utils hasn't been loaded yet
  }
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
  persistSubagentRuns();
}

export function releaseSubagentRun(runId: string) {
  cleanupInProgress.delete(runId);
  resumedRuns.delete(runId);
  const didDelete = subagentRuns.delete(runId);
  if (didDelete) {
    persistSubagentRuns();
    void cleanupProgressFileForRun(runId).catch(() => {});
  }
  if (subagentRuns.size === 0) {
    stopSweeper();
  }
}

export function updateRunRecord(runId: string, patch: Partial<SubagentRunRecord>): void {
  restoreSubagentRunsOnce();
  const entry = subagentRuns.get(runId);
  if (!entry) {
    log.warn(`subagent run not found for update: ${runId}`);
    return;
  }
  Object.assign(entry, patch);
  persistSubagentRuns();
}

export function getRunById(runId: string): SubagentRunRecord | undefined {
  restoreSubagentRunsOnce();
  return subagentRuns.get(runId);
}

export function listSubagentRunsForRequester(requesterSessionKey: string): SubagentRunRecord[] {
  restoreSubagentRunsOnce();
  const key = requesterSessionKey.trim();
  if (!key) {
    return [];
  }
  return [...subagentRuns.values()].filter((entry) => entry.requesterSessionKey === key);
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
  import("../sessions/session-key-utils.js")
    .then((mod) => {
      mod.setRegistryAccessor?.(getRunByChildKey);
    })
    .catch(() => {
      // ignore dynamic import failures
    });
}
