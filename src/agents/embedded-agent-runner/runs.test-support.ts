import "./runs.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  ACTIVE_EMBEDDED_RUN_SNAPSHOTS,
  ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE,
  ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY,
  EMBEDDED_RUN_COMPLETION_CLAIMS,
  EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS,
  EMBEDDED_RUN_WAITERS,
  RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS,
  type EmbeddedAgentQueueHandle,
} from "./run-state.js";

type RunHandle = EmbeddedAgentQueueHandle;

export function createEmbeddedRunHandle(
  overrides: {
    abort?: () => void;
    isAbortable?: boolean;
    isCompacting?: boolean;
    isStreaming?: boolean;
    isStopped?: () => boolean;
    messageInjection?: RunHandle["messageInjection"];
    runId?: string;
    toolAuthorityFingerprint?: string;
    queueMessage?: RunHandle["queueMessage"];
    supportsQueueMessageImages?: boolean;
    supportsTranscriptCommitWait?: boolean;
  } = {},
): RunHandle {
  // Minimal handle fixture with overrideable lifecycle probes for registry
  // behavior; individual tests supply queue/abort behavior when needed.
  const abort = overrides.abort ?? (() => {});
  return {
    runId: overrides.runId,
    toolAuthorityFingerprint: overrides.toolAuthorityFingerprint,
    queueMessage: overrides.queueMessage ?? (async () => {}),
    ...(overrides.messageInjection ? { messageInjection: overrides.messageInjection } : {}),
    isStreaming: () => overrides.isStreaming ?? true,
    ...(overrides.isStopped ? { isStopped: overrides.isStopped } : {}),
    ...(overrides.isAbortable !== undefined
      ? { isAbortable: () => overrides.isAbortable !== false }
      : {}),
    isCompacting: () => overrides.isCompacting ?? false,
    supportsQueueMessageImages: overrides.supportsQueueMessageImages,
    supportsTranscriptCommitWait: overrides.supportsTranscriptCommitWait,
    abort,
  };
}

type EmbeddedRunsTestApi = {
  persistForceClearedEmbeddedRunTerminalState(params: {
    sessionId: string;
    sessionKey: string;
    startedAt?: number;
    storePath: string;
    updatedAt: number;
  }): Promise<void>;
};

function getTestApi(): EmbeddedRunsTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedRunsTestApi")
  ];
  if (!api) {
    throw new Error("embedded runs test API is unavailable");
  }
  return api as EmbeddedRunsTestApi;
}

export const testing = {
  ...getTestApi(),
  resetActiveEmbeddedRuns() {
    for (const handle of ACTIVE_EMBEDDED_RUNS.values()) {
      EMBEDDED_RUN_FORCED_TERMINAL_SETTLEMENTS.delete(handle);
    }
    for (const waiters of EMBEDDED_RUN_WAITERS.values()) {
      for (const waiter of waiters) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve(!waiter.handle);
      }
    }
    EMBEDDED_RUN_WAITERS.clear();
    ACTIVE_EMBEDDED_RUNS.clear();
    ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.clear();
    for (const claim of EMBEDDED_RUN_COMPLETION_CLAIMS.values()) {
      claim.settleRegistration(undefined);
    }
    EMBEDDED_RUN_COMPLETION_CLAIMS.clear();
    RETAINED_EMBEDDED_RUN_ABORTABILITY_RUN_IDS.clear();
    ACTIVE_EMBEDDED_RUN_SNAPSHOTS.clear();
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
    ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
    ABANDONED_EMBEDDED_RUNS_BY_SESSION_ID.clear();
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_KEY.clear();
    ABANDONED_EMBEDDED_RUN_SESSION_IDS_BY_FILE.clear();
  },
};
