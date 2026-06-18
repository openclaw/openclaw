/**
 * Shared process-local state for active and abandoned embedded-agent runs.
 */
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import {
  getActiveReplyRunCount,
  isReplyRunActiveForSessionId,
  listActiveReplyRunSessionKeys,
  listActiveReplyRunSessionIds,
  resolveActiveReplyRunSessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveEmbeddedSessionFileKey } from "./session-file-key.js";

/**
 * Shared process state for embedded-agent runs, queues, snapshots, and model-switch requests.
 *
 * The maps are global-singleton backed so reloads and lazy imports inside the same gateway process
 * do not split active-run bookkeeping.
 */
export type EmbeddedAgentQueueHandle = {
  kind?: "embedded";
  queueMessage: (text: string, options?: EmbeddedAgentQueueMessageOptions) => Promise<void>;
  isStreaming: () => boolean;
  isCompacting: () => boolean;
  supportsTranscriptCommitWait?: boolean;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
  abort: (reason?: "restart") => void;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};

export type EmbeddedAgentQueueMessageOptions = {
  steeringMode?: "all";
  debounceMs?: number;
  deliveryTimeoutMs?: number;
  waitForTranscriptCommit?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
};

export type ActiveEmbeddedRunSnapshot = {
  transcriptLeafId: string | null;
  messages?: unknown[];
  inFlightPrompt?: string;
};

export type EmbeddedRunModelSwitchRequest = {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

export type EmbeddedRunWaiter = {
  resolve: (ended: boolean) => void;
  timer: NodeJS.Timeout;
};

export type AbandonedEmbeddedRun = {
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  abandonedAtMs: number;
  reason: "timeout";
};

const EMBEDDED_RUN_STATE_KEY = Symbol.for("openclaw.embeddedRunState");

const embeddedRunState = resolveGlobalSingleton(EMBEDDED_RUN_STATE_KEY, () => ({
  activeRuns: new Map<string, EmbeddedAgentQueueHandle>(),
  snapshots: new Map<string, ActiveEmbeddedRunSnapshot>(),
  sessionIdsByKey: new Map<string, string>(),
  sessionIdsByFile: new Map<string, string>(),
  abandonedRunsBySessionId: new Map<string, AbandonedEmbeddedRun>(),
  abandonedRunSessionIdsByKey: new Map<string, string>(),
  abandonedRunSessionIdsByFile: new Map<string, string>(),
  waiters: new Map<string, Set<EmbeddedRunWaiter>>(),
  modelSwitchRequests: new Map<string, EmbeddedRunModelSwitchRequest>(),
}));

export const ACTIVE_EMBEDDED_RUNS =
  embeddedRunState.activeRuns ??
  (embeddedRunState.activeRuns = new Map<string, EmbeddedAgentQueueHandle>());
export const ACTIVE_EMBEDDED_RUN_SNAPSHOTS =
  embeddedRunState.snapshots ??
  (embeddedRunState.snapshots = new Map<string, ActiveEmbeddedRunSnapshot>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.sessionIdsByKey ??
  (embeddedRunState.sessionIdsByKey = new Map<string, string>());
export const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.sessionIdsByFile ??
  (embeddedRunState.sessionIdsByFile = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID =
  embeddedRunState.abandonedRunsBySessionId ??
  (embeddedRunState.abandonedRunsBySessionId = new Map<string, AbandonedEmbeddedRun>());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY =
  embeddedRunState.abandonedRunSessionIdsByKey ??
  (embeddedRunState.abandonedRunSessionIdsByKey = new Map<string, string>());
export const ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE =
  embeddedRunState.abandonedRunSessionIdsByFile ??
  (embeddedRunState.abandonedRunSessionIdsByFile = new Map<string, string>());
export const EMBEDDED_RUN_WAITERS =
  embeddedRunState.waiters ??
  (embeddedRunState.waiters = new Map<string, Set<EmbeddedRunWaiter>>());
export const EMBEDDED_RUN_MODEL_SWITCH_REQUESTS =
  embeddedRunState.modelSwitchRequests ??
  (embeddedRunState.modelSwitchRequests = new Map<string, EmbeddedRunModelSwitchRequest>());

/** Counts active embedded runs while including auto-reply registry runs for shared sessions. */
export function getActiveEmbeddedRunCount(): number {
  let activeCount = ACTIVE_EMBEDDED_RUNS.size;
  for (const sessionId of listActiveReplyRunSessionIds()) {
    if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
      activeCount += 1;
    }
  }
  return Math.max(activeCount, getActiveReplyRunCount());
}

/** Lists active embedded-run session keys from both embedded and auto-reply registries. */
export function listActiveEmbeddedRunSessionKeys(): string[] {
  return [
    ...new Set([
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.keys(),
      ...listActiveReplyRunSessionKeys(),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
}

/** Lists active embedded-run session ids from all embedded-run lookup maps. */
export function listActiveEmbeddedRunSessionIds(): string[] {
  return [
    ...new Set([
      ...ACTIVE_EMBEDDED_RUNS.keys(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.values(),
      ...ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.values(),
      ...listActiveReplyRunSessionIds(),
    ]),
  ].toSorted((a, b) => a.localeCompare(b));
}

/** Resolves the current session id for an active run after resets or compaction. */
export function resolveActiveEmbeddedRunSessionId(sessionKey: string): string | undefined {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    return undefined;
  }
  return (
    resolveActiveReplyRunSessionId(normalizedSessionKey) ??
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey)
  );
}

export type EmbeddedRunDiagnosticSnapshot = {
  active: boolean;
  sessionId?: string;
  sessionKey?: string;
  streaming?: boolean;
  compacting?: boolean;
  transcriptCommitWait?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  hasTranscriptSnapshot?: boolean;
  abandoned?: {
    sessionId: string;
    sessionKey?: string;
    abandonedAtMs: number;
    reason: AbandonedEmbeddedRun["reason"];
  };
};

function resolveEmbeddedRunDiagnosticSessionId(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): string | undefined {
  const sessionId = params.sessionId?.trim();
  if (
    sessionId &&
    (ACTIVE_EMBEDDED_RUNS.has(sessionId) || isReplyRunActiveForSessionId(sessionId))
  ) {
    return sessionId;
  }
  const sessionKey = params.sessionKey?.trim();
  if (sessionKey) {
    const activeSessionId =
      resolveActiveReplyRunSessionId(sessionKey) ??
      ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(sessionKey);
    if (activeSessionId) {
      return activeSessionId;
    }
    const abandonedSessionId = ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(sessionKey);
    if (abandonedSessionId) {
      return abandonedSessionId;
    }
  }
  const sessionFile = params.sessionFile?.trim();
  if (sessionFile) {
    const sessionFileKey = resolveEmbeddedSessionFileKey(sessionFile);
    const activeSessionId = ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey);
    if (activeSessionId) {
      return activeSessionId;
    }
    const abandonedSessionId = ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.get(sessionFileKey);
    if (abandonedSessionId) {
      return abandonedSessionId;
    }
  }
  if (sessionId) {
    return sessionId;
  }
  return undefined;
}

/** Projects embedded run state for read-only diagnostics without exposing prompts or messages. */
export function getEmbeddedRunDiagnosticSnapshot(params: {
  sessionId?: string;
  sessionKey?: string;
  sessionFile?: string;
}): EmbeddedRunDiagnosticSnapshot {
  const sessionId = resolveEmbeddedRunDiagnosticSessionId(params);
  const handle = sessionId ? ACTIVE_EMBEDDED_RUNS.get(sessionId) : undefined;
  const abandoned = sessionId ? ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.get(sessionId) : undefined;
  const replyRunActive = sessionId ? isReplyRunActiveForSessionId(sessionId) : false;
  return {
    active: Boolean(handle) || replyRunActive,
    ...(sessionId ? { sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(handle ? { streaming: handle.isStreaming() } : {}),
    ...(handle ? { compacting: handle.isCompacting() } : {}),
    ...(handle?.supportsTranscriptCommitWait !== undefined
      ? { transcriptCommitWait: handle.supportsTranscriptCommitWait }
      : {}),
    ...(handle?.sourceReplyDeliveryMode
      ? { sourceReplyDeliveryMode: handle.sourceReplyDeliveryMode }
      : {}),
    ...(sessionId ? { hasTranscriptSnapshot: ACTIVE_EMBEDDED_RUN_SNAPSHOTS.has(sessionId) } : {}),
    ...(abandoned
      ? {
          abandoned: {
            sessionId: abandoned.sessionId,
            ...(abandoned.sessionKey ? { sessionKey: abandoned.sessionKey } : {}),
            abandonedAtMs: abandoned.abandonedAtMs,
            reason: abandoned.reason,
          },
        }
      : {}),
  };
}
