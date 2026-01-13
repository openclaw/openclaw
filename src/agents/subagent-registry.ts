import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { runSubagentAnnounceFlow } from "./subagent-announce.js";
import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterChannel?: string;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  archiveAtMs?: number;
  announceHandled: boolean;
};

const subagentRuns = new Map<string, SubagentRunRecord>();
let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;
let restoreAttempted = false;

function persistSubagentRuns() {
  try {
    saveSubagentRegistryToDisk(subagentRuns);
  } catch {
    // ignore persistence failures
  }
}

const resumedRuns = new Set<string>();

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) return;
  const entry = subagentRuns.get(runId);
  if (!entry) return;
  if (entry.announceHandled) return;

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    if (!beginSubagentAnnounce(runId)) return;
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterProvider: entry.requesterProvider,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
    });
    if (entry.cleanup === "delete") {
      subagentRuns.delete(runId);
      persistSubagentRuns();
    }
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
  if (restoreAttempted) return;
  restoreAttempted = true;
  try {
    const restored = loadSubagentRegistryFromDisk();
    if (restored.size === 0) return;
    for (const [runId, entry] of restored.entries()) {
      if (!runId || !entry) continue;
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
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

function resolveSubagentWaitTimeoutMs(
  cfg: ReturnType<typeof loadConfig>,
  runTimeoutSeconds?: number,
) {
  return resolveAgentTimeoutMs({ cfg, overrideSeconds: runTimeoutSeconds });
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepSubagentRuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

async function sweepSubagentRuns() {
  const now = Date.now();
  let mutated = false;
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!entry.archiveAtMs || entry.archiveAtMs > now) continue;
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
  if (mutated) persistSubagentRuns();
  if (subagentRuns.size === 0) stopSweeper();
}

function ensureListener() {
  if (listenerStarted) return;
  listenerStarted = true;
  onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") return;
    const entry = subagentRuns.get(evt.runId);
    if (!entry) {
      return;
    }
    const phase = evt.data?.phase;
    if (phase === "start") {
      const startedAt =
        typeof evt.data?.startedAt === "number"
          ? (evt.data.startedAt as number)
          : undefined;
      if (startedAt) {
        entry.startedAt = startedAt;
        persistSubagentRuns();
      }
      return;
    }
    if (phase !== "end" && phase !== "error") return;
    const endedAt =
      typeof evt.data?.endedAt === "number"
        ? (evt.data.endedAt as number)
        : Date.now();
    entry.endedAt = endedAt;
    persistSubagentRuns();

    if (!beginSubagentAnnounce(evt.runId)) {
      if (entry.cleanup === "delete") {
        subagentRuns.delete(evt.runId);
        persistSubagentRuns();
      }
      return;
    }
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterChannel: entry.requesterChannel,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
    });
    if (entry.cleanup === "delete") {
      subagentRuns.delete(evt.runId);
      persistSubagentRuns();
    }
  });
}

export function beginSubagentAnnounce(runId: string) {
  const entry = subagentRuns.get(runId);
  if (!entry) return false;
  if (entry.announceHandled) return false;
  entry.announceHandled = true;
  persistSubagentRuns();
  return true;
}

export function registerSubagentRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterChannel?: string;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  runTimeoutSeconds?: number;
}) {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(
    cfg,
    params.runTimeoutSeconds,
  );
  subagentRuns.set(params.runId, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterChannel: params.requesterChannel,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    label: params.label,
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    announceHandled: false,
  });
  ensureListener();
  persistSubagentRuns();
  if (archiveAfterMs) startSweeper();
  // Wait for subagent completion via gateway RPC (cross-process).
  // The in-process lifecycle listener is a fallback for embedded runs.
  void waitForSubagentCompletion(params.runId, waitTimeoutMs);
}

async function waitForSubagentCompletion(runId: string, waitTimeoutMs: number) {
  try {
    const timeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
    const wait = (await callGateway({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 10_000,
    })) as { status?: string; startedAt?: number; endedAt?: number };
    if (wait?.status !== "ok" && wait?.status !== "error") return;
    const entry = subagentRuns.get(runId);
    if (!entry) return;
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
    if (mutated) persistSubagentRuns();
    if (!beginSubagentAnnounce(runId)) return;
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterChannel: entry.requesterChannel,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
    });
    if (entry.cleanup === "delete") {
      subagentRuns.delete(runId);
      persistSubagentRuns();
    }
  } catch {
    // ignore
  }
}

export function resetSubagentRegistryForTests() {
  subagentRuns.clear();
  stopSweeper();
  restoreAttempted = false;
  listenerStarted = false;
  persistSubagentRuns();
}

export function releaseSubagentRun(runId: string) {
  const didDelete = subagentRuns.delete(runId);
  if (didDelete) persistSubagentRuns();
  if (subagentRuns.size === 0) stopSweeper();
}

// Best-effort: restore persisted runs on process start so announces/cleanup can
// continue after gateway restarts.
restoreSubagentRunsOnce();
