import { existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  type SubagentRunOutcome,
  withSubagentOutcomeTiming,
} from "./subagent-announce-output.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
} from "./subagent-lifecycle-events.js";
import { shouldUpdateRunOutcome } from "./subagent-registry-completion.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

export const MIN_ANNOUNCE_RETRY_DELAY_MS = 1_000;
export const MAX_ANNOUNCE_RETRY_DELAY_MS = 8_000;
export const MAX_ANNOUNCE_RETRY_COUNT = 3;
export const ANNOUNCE_EXPIRY_MS = 5 * 60_000;
export const ANNOUNCE_COMPLETION_HARD_EXPIRY_MS = 30 * 60_000;

const FROZEN_RESULT_TEXT_MAX_BYTES = 100 * 1024;

export type SubagentRunOrphanReason = "missing-session-entry" | "missing-session-id";

export function capFrozenResultText(resultText: string): string {
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

export function resolveAnnounceRetryDelayMs(retryCount: number) {
  const boundedRetryCount = Math.max(0, Math.min(retryCount, 10));
  // retryCount is "attempts already made", so retry #1 waits 1s, then 2s, 4s...
  const backoffExponent = Math.max(0, boundedRetryCount - 1);
  const baseDelay = MIN_ANNOUNCE_RETRY_DELAY_MS * 2 ** backoffExponent;
  return Math.min(baseDelay, MAX_ANNOUNCE_RETRY_DELAY_MS);
}

export function logAnnounceGiveUp(entry: SubagentRunRecord, reason: "retry-limit" | "expiry") {
  const retryCount = entry.announceRetryCount ?? 0;
  const endedAgoMs =
    typeof entry.endedAt === "number" ? Math.max(0, Date.now() - entry.endedAt) : undefined;
  const endedAgoLabel = endedAgoMs != null ? `${Math.round(endedAgoMs / 1000)}s` : "n/a";
  defaultRuntime.log(
    `[warn] Subagent announce give up (${reason}) run=${entry.runId} child=${entry.childSessionKey} requester=${entry.requesterSessionKey} retries=${retryCount} endedAgo=${endedAgoLabel}`,
  );
}

function findSessionEntryByKey(store: Record<string, SessionEntry>, sessionKey: string) {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  for (const [key, entry] of Object.entries(store)) {
    if (normalizeLowercaseStringOrEmpty(key) === normalized) {
      return entry;
    }
  }
  return undefined;
}

export async function persistSubagentSessionTiming(entry: SubagentRunRecord) {
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

export function resolveSubagentRunOrphanReason(params: {
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

export async function safeRemoveAttachmentsDir(entry: SubagentRunRecord): Promise<void> {
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

/**
 * Check whether a subagent run's transcript contains a completed (non-pending) assistant reply.
 * Used to recover runs that finished successfully before a gateway restart but whose
 * completion wasn't persisted to the run registry.
 */
function hasCompletedTranscript(entry: SubagentRunRecord): boolean {
  try {
    const childSessionKey = entry.childSessionKey?.trim();
    if (!childSessionKey) {
      return false;
    }
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(childSessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const sessionEntry = findSessionEntryByKey(store, childSessionKey);
    if (!sessionEntry?.sessionId) {
      return false;
    }
    const sessionPathOpts = resolveSessionFilePathOptions({ agentId, storePath });
    const sessionFilePath = resolveSessionFilePath(
      sessionEntry.sessionId,
      sessionEntry,
      sessionPathOpts,
    );
    if (!existsSync(sessionFilePath)) {
      return false;
    }
    const lines = readFileSync(sessionFilePath, "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]) as { message?: unknown };
        const msg = (parsed.message ?? parsed) as { role?: string; content?: unknown };
        if (msg.role === "assistant" && msg.content) {
          const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
          const hasPendingTool = blocks.some(
            (b: unknown) =>
              typeof b === "object" &&
              b !== null &&
              (b as Record<string, unknown>).type === "tool_use",
          );
          if (!hasPendingTool) {
            return true;
          }
        }
        if (msg.role === "user" || msg.role === "system") {
          break;
        }
      } catch {
        // skip malformed lines
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function reconcileOrphanedRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  reason: SubagentRunOrphanReason;
  source: "restore" | "resume";
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
}) {
  const now = Date.now();
  let changed = false;
  // Before marking as errored, check whether the transcript shows the run already
  // completed successfully. This recovers runs that finished before a gateway restart
  // but whose completion wasn't flushed to the run registry.
  if (typeof params.entry.endedAt !== "number" && hasCompletedTranscript(params.entry)) {
    params.entry.endedAt = now;
    const completedOutcome: SubagentRunOutcome = withSubagentOutcomeTiming(
      { status: "ok" },
      {
        startedAt: params.entry.startedAt,
        endedAt: params.entry.endedAt,
      },
    );
    if (shouldUpdateRunOutcome(params.entry.outcome, completedOutcome)) {
      params.entry.outcome = completedOutcome;
      changed = true;
    }
    params.entry.endedReason = SUBAGENT_ENDED_REASON_COMPLETE;
    defaultRuntime.log(
      `[info] subagent-restart: recovered completed run=${params.runId} child=${params.entry.childSessionKey} (transcript had final assistant reply)`,
    );
    return true;
  }
  if (typeof params.entry.endedAt !== "number") {
    params.entry.endedAt = now;
    changed = true;
  }
  const orphanOutcome = withSubagentOutcomeTiming(
    {
      status: "error",
      error: `orphaned subagent run (${params.reason})`,
    },
    {
      startedAt: params.entry.startedAt,
      endedAt: params.entry.endedAt,
    },
  );
  if (shouldUpdateRunOutcome(params.entry.outcome, orphanOutcome)) {
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
  const shouldDeleteAttachments =
    params.entry.cleanup === "delete" || !params.entry.retainAttachmentsOnKeep;
  if (shouldDeleteAttachments) {
    void safeRemoveAttachmentsDir(params.entry);
  }
  const removed = params.runs.delete(params.runId);
  params.resumedRuns.delete(params.runId);
  if (!removed && !changed) {
    return false;
  }
  defaultRuntime.log(
    `[warn] Subagent orphan run pruned source=${params.source} run=${params.runId} child=${params.entry.childSessionKey} reason=${params.reason}`,
  );
  return true;
}

export function reconcileOrphanedRestoredRuns(params: {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
}) {
  const storeCache = new Map<string, Record<string, SessionEntry>>();
  let changed = false;
  for (const [runId, entry] of params.runs.entries()) {
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
        runs: params.runs,
        resumedRuns: params.resumedRuns,
      })
    ) {
      changed = true;
    }
  }
  return changed;
}

export function resolveArchiveAfterMs(cfg?: OpenClawConfig) {
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
