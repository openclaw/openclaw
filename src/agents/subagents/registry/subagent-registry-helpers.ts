/**
 * Subagent registry persistence and recovery helpers.
 *
 * Handles frozen results, attachment cleanup, timing persistence, and announce retry logging.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES } from "../../../config/agent-limits.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { computeBackoff } from "../../../infra/backoff.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  recordGatewaySessionRunFailure,
  resolveSessionRunError,
} from "../../../sessions/session-run-error.js";
import { truncateUtf8Prefix } from "../../../utils/utf8-truncate.js";
import { getDeliveryAttemptCount, getDeliveryLastError } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";
import { resolveCompletionFromSessionEntry } from "./subagent-session-reconciliation.js";

export const PROVISIONAL_KILL_RECONCILIATION_MS = 5 * 60_000;
export const MIN_ANNOUNCE_RETRY_DELAY_MS = 15_000;
const MAX_ANNOUNCE_RETRY_DELAY_MS = 5 * 60_000;
const ANNOUNCE_RETRY_JITTER = 0.2;
export const ANNOUNCE_EXPIRY_MS = 5 * 60_000;
export const ANNOUNCE_COMPLETION_HARD_EXPIRY_MS = 30 * 60_000;

const ANNOUNCE_RETRY_BACKOFF = {
  initialMs: MIN_ANNOUNCE_RETRY_DELAY_MS,
  maxMs: MAX_ANNOUNCE_RETRY_DELAY_MS,
  factor: 2,
  jitter: ANNOUNCE_RETRY_JITTER,
};

const FROZEN_RESULT_TEXT_MAX_BYTES = 100 * 1024;

/** Caps frozen completion text stored for later announce/recovery delivery. */
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
  const payload = truncateUtf8Prefix(trimmed, maxPayloadBytes);
  return `${payload}${notice}`;
}

/** Computes bounded exponential backoff for subagent announce retries. */
export function resolveAnnounceRetryDelayMs(retryCount: number) {
  return computeBackoff(ANNOUNCE_RETRY_BACKOFF, Math.max(1, retryCount));
}

function formatAnnounceGiveUpLogField(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(
    normalized.length > 2_000 ? `${truncateUtf16Safe(normalized, 2_000)}…` : normalized,
  );
}

/** Logs a sanitized final give-up line for failed subagent announce delivery. */
export function logAnnounceGiveUp(
  entry: SubagentRunRecord,
  reason: "expiry" | "permanent_failure",
) {
  const retryCount = getDeliveryAttemptCount(entry);
  const endedAt = entry.execution.endedAt;
  const endedAgoMs = typeof endedAt === "number" ? Math.max(0, Date.now() - endedAt) : undefined;
  const endedAgoLabel = endedAgoMs != null ? `${Math.round(endedAgoMs / 1000)}s` : "n/a";
  const lastDeliveryError = getDeliveryLastError(entry);
  const deliveryError = lastDeliveryError
    ? ` deliveryError=${formatAnnounceGiveUpLogField(lastDeliveryError)}`
    : "";
  defaultRuntime.log(
    `[warn] Subagent announce give up (${reason}) run=${entry.runId} child=${entry.childSessionKey} requester=${entry.requesterSessionKey} retries=${retryCount} endedAgo=${endedAgoLabel}${deliveryError}`,
  );
}

/** Persists child session timing/status derived from the subagent registry row. */
export async function persistSubagentSessionTiming(
  entry: SubagentRunRecord,
  options?: {
    isCurrentGeneration?: () => boolean;
    assertCommitAllowed?: () => void;
  },
) {
  const childSessionKey = entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return;
  }

  const cfg = getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(childSessionKey);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const startedAt = getSubagentSessionStartedAt(entry);
  const endedAt =
    typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt)
      ? entry.execution.endedAt
      : undefined;
  const runtimeMs =
    endedAt !== undefined
      ? getSubagentSessionRuntimeMs(entry, endedAt)
      : getSubagentSessionRuntimeMs(entry);
  const status = resolveSubagentSessionStatus(entry);

  const lastRunError = status
    ? resolveSessionRunError(entry.execution.outcome ?? {}, status)
    : undefined;
  const persisted = await patchSessionEntryCore(
    { storePath, sessionKey: childSessionKey },
    (sessionEntry) => {
      // Recheck under the session-store write lock. A completion may have
      // waited behind a steer/restart that transferred this session's ownership.
      if (options?.isCurrentGeneration && !options.isCurrentGeneration()) {
        return null;
      }
      if (status === "killed") {
        const existingCompletion = resolveCompletionFromSessionEntry(sessionEntry, Date.now(), {
          notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
        });
        if (existingCompletion && existingCompletion.reason !== SUBAGENT_ENDED_REASON_KILLED) {
          // A provider result already reached durable session state. The kill
          // marker is provisional and must not erase restart reconciliation evidence
          // or leave the session looking aborted after that completion won.
          if (sessionEntry.abortedLastRun !== true) {
            return null;
          }
          const completedEntry = { ...sessionEntry };
          delete completedEntry.abortedLastRun;
          return completedEntry;
        }
      }
      const next = { ...sessionEntry };

      if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
        next.startedAt = startedAt;
      } else {
        delete next.startedAt;
      }

      if (typeof endedAt === "number" && Number.isFinite(endedAt)) {
        next.endedAt = endedAt;
      } else {
        delete next.endedAt;
      }

      if (typeof runtimeMs === "number" && Number.isFinite(runtimeMs)) {
        next.runtimeMs = runtimeMs;
      } else {
        delete next.runtimeMs;
      }

      if (status) {
        next.status = status;
      } else {
        delete next.status;
      }
      if (lastRunError) {
        next.lastRunError = lastRunError;
      } else if (status === "done") {
        delete next.lastRunError;
      }
      if (status && status !== "killed") {
        delete next.abortedLastRun;
      }
      return next;
    },
    {
      assertCommitAllowed: options?.assertCommitAllowed,
      replaceEntry: true,
    },
  );
  if (persisted && lastRunError) {
    await recordGatewaySessionRunFailure({
      target: {
        agentId,
        storePath,
        sessionKey: childSessionKey,
        sessionId: persisted.sessionId,
        expectedLifecycleRevision: persisted.lifecycleRevision,
      },
      runId: entry.runId,
      error: entry.execution.outcome?.error,
      assertCommitAllowed: options?.assertCommitAllowed,
    });
  }
}

// Attachment cleanup must stay within the recorded root even if paths were
// symlinks. Compare real paths before removing anything recursively.
function isResolvedChildPath(params: { childPath: string; rootPath: string }) {
  const rootWithSep = params.rootPath.endsWith(path.sep)
    ? params.rootPath
    : `${params.rootPath}${path.sep}`;
  return params.childPath.startsWith(rootWithSep);
}

/** Best-effort async removal for a subagent attachment directory. */
export async function safeRemoveAttachmentsDir(entry: SubagentRunRecord): Promise<boolean> {
  if (!entry.attachmentsDir || !entry.attachmentsRootDir) {
    return true;
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
      return true;
    }

    const rootBase = rootReal ?? path.resolve(entry.attachmentsRootDir);
    const dirBase = dirReal;
    if (!isResolvedChildPath({ childPath: dirBase, rootPath: rootBase })) {
      return false;
    }
    await fs.rm(dirBase, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Resolves the completed subagent archive delay from config. */
function resolveArchiveAfterMs(cfg?: OpenClawConfig) {
  const config = cfg ?? getRuntimeConfig();
  const minutes =
    config.agents?.defaults?.subagents?.archiveAfterMinutes ??
    DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES;
  if (!Number.isFinite(minutes) || minutes < 0) {
    return undefined;
  }
  if (minutes === 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

/** Arms retention only after the run or its waitable collector result has completed. */
export function updateSubagentArchiveAtMs(entry: SubagentRunRecord, cfg?: OpenClawConfig): boolean {
  const endedAt =
    typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt)
      ? entry.execution.endedAt
      : undefined;
  const completedAt = entry.collect
    ? endedAt === undefined && !entry.collectorCompletion
      ? undefined
      : typeof entry.completion?.capturedAt === "number" &&
          Number.isFinite(entry.completion.capturedAt)
        ? entry.completion.capturedAt
        : endedAt
    : entry.cleanup === "delete" && entry.pauseReason !== "sessions_yield"
      ? endedAt
      : undefined;
  const archiveAfterMs =
    entry.spawnMode === "session" || completedAt === undefined
      ? undefined
      : resolveArchiveAfterMs(cfg);
  const expectedArchiveAt =
    completedAt !== undefined && archiveAfterMs !== undefined
      ? completedAt + archiveAfterMs
      : undefined;
  if (entry.archiveAtMs === expectedArchiveAt) {
    return false;
  }
  if (expectedArchiveAt === undefined) {
    delete entry.archiveAtMs;
  } else {
    entry.archiveAtMs = expectedArchiveAt;
  }
  return true;
}
