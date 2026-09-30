import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES } from "../../../config/agent-limits.js";
import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
} from "../../../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry, SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { computeBackoff } from "../../../infra/backoff.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  recordGatewaySessionRunFailure,
  resolveSessionRunError,
} from "../../../sessions/session-run-error.js";
import { truncateUtf8Prefix } from "../../../utils/utf8-truncate.js";
import { cleanupMaterializedSubagentAttachments } from "../subagent-attachment-cleanup.js";
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
    session?: {
      storePath: string;
      entry?: SessionEntry;
      assertCurrent: () => void;
    };
    isCurrentGeneration?: () => boolean;
    assertCommitAllowed?: () => void;
    assertCurrentEntry?: (entry: SessionEntryCurrentFacts | undefined) => void;
    sessionEntryCurrent?: SessionEntryCurrentCheck;
  },
) {
  const childSessionKey = entry.childSessionKey?.trim();
  if (!childSessionKey || options?.isCurrentGeneration?.() === false) {
    return;
  }

  const cfg = getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(childSessionKey);
  const storePath =
    options?.sessionEntryCurrent?.source.path ??
    options?.session?.storePath ??
    resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const refused = new Error("Subagent timing owner changed before commit");
  const assertGenerationCurrent = () => {
    if (options?.isCurrentGeneration?.() === false) {
      throw refused;
    }
    options?.assertCommitAllowed?.();
  };
  const startedAt = getSubagentSessionStartedAt(entry);
  const endedAt =
    typeof entry.execution.endedAt === "number" && Number.isFinite(entry.execution.endedAt)
      ? entry.execution.endedAt
      : undefined;
  const runtimeMs = getSubagentSessionRuntimeMs(entry, endedAt);
  const status = resolveSubagentSessionStatus(entry);

  const lastRunError = status
    ? resolveSessionRunError(entry.execution.outcome ?? {}, status)
    : undefined;
  const update = (sessionEntry: InternalSessionEntry) => {
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

    for (const [key, value] of [
      ["startedAt", startedAt],
      ["endedAt", endedAt],
      ["runtimeMs", runtimeMs],
    ] as const) {
      if (typeof value === "number" && Number.isFinite(value)) {
        next[key] = value;
      } else {
        delete next[key];
      }
    }

    if (status) {
      next.status = status;
    } else {
      delete next.status;
    }
    if (lastRunError) {
      next.lastRunError = lastRunError;
    } else if (status === "done" || status === "interrupted") {
      delete next.lastRunError;
    }
    if (status && status !== "killed") {
      delete next.abortedLastRun;
    }
    return next;
  };
  const persist = async (expected: SessionEntry | undefined, assertSessionCurrent?: () => void) => {
    let selected: InternalSessionEntry | undefined;
    let suppressed = false;
    const assertCurrent = () => {
      assertGenerationCurrent();
      assertSessionCurrent?.();
      if (selected) {
        try {
          if (options?.sessionEntryCurrent) {
            options.sessionEntryCurrent.assertCurrent(selected);
          } else {
            options?.assertCurrentEntry?.(selected);
          }
        } catch (error) {
          suppressed = true;
          throw error;
        }
      }
    };
    const persisted = await applySessionEntryExactReplacements<InternalSessionEntry | undefined>({
      agentId,
      storePath,
      sessionKeys: [childSessionKey],
      activeSessionKey: childSessionKey,
      requireWriteSuccess: true,
      skipMaintenance: true,
      assertCommitAllowed: assertCurrent,
      update: ([row]) => {
        if (
          !row ||
          options?.isCurrentGeneration?.() === false ||
          (expected &&
            (row.entry.sessionId !== expected.sessionId ||
              row.entry.lifecycleRevision !== expected.lifecycleRevision))
        ) {
          return { result: undefined };
        }
        selected = row.entry;
        assertCurrent();
        const next = update(selected);
        return {
          result: next ?? selected,
          ...(next ? { replacements: [{ sessionKey: row.sessionKey, entry: next }] } : {}),
        };
      },
    }).catch((error: unknown) => {
      if (hasSqliteWorkerOutcomeUnknown(error) || !suppressed) {
        throw error;
      }
      return undefined;
    });
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
        assertCommitAllowed: assertCurrent,
        sessionEntryCurrent: options?.sessionEntryCurrent,
      });
    }
  };
  try {
    if (options?.session) {
      options.session.assertCurrent();
      if (options.session.entry) {
        await persist(options.session.entry, options.session.assertCurrent);
      }
      return;
    }
    if (options?.sessionEntryCurrent) {
      await persist(undefined);
      return;
    }
    await withSessionEntryReadOnlyInWorker(
      { storePath, sessionKey: childSessionKey, agentId },
      assertGenerationCurrent,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        if (read.value) {
          await persist(read.value, owner.assertCurrent);
        }
      },
    );
  } catch (error) {
    // A duplicate completion can retire this generation while its reader drains.
    if (error !== refused) {
      throw error;
    }
  }
}

/** Best-effort async removal for a subagent attachment directory. */
export async function safeRemoveAttachmentsDir(
  entry: SubagentRunRecord,
  isCurrent?: () => boolean,
): Promise<boolean> {
  if (!entry.attachmentId) {
    // Legacy absolute/workspace paths are untrusted and intentionally retired without traversal.
    return true;
  }

  try {
    await cleanupMaterializedSubagentAttachments({
      childSessionKey: entry.childSessionKey,
      attachmentId: entry.attachmentId,
      isCurrent,
    });
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
  if (!Number.isFinite(minutes) || minutes <= 0) {
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
      ? entry.delivery?.discardReason === "task-missing"
        ? (entry.delivery.discardedAt ?? endedAt)
        : endedAt
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
