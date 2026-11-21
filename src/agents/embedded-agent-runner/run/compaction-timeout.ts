import type { AgentMessage } from "../../runtime/index.js";

/** Flags only run-timeout events that overlap pending, retrying, or active compaction work. */
export function shouldFlagCompactionTimeout(signal: {
  isTimeout: boolean;
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
}): boolean {
  return signal.isTimeout && (signal.isCompactionPendingOrRetrying || signal.isCompactionInFlight);
}

/**
 * Grants a single timeout grace window when compaction is still responsible for
 * the delay. A second timeout, or a timeout unrelated to compaction, aborts the
 * run instead of extending indefinitely.
 */
export function resolveRunTimeoutDuringCompaction(params: {
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
  graceAlreadyUsed: boolean;
}): "extend" | "abort" {
  if (!params.isCompactionPendingOrRetrying && !params.isCompactionInFlight) {
    return "abort";
  }
  return params.graceAlreadyUsed ? "abort" : "extend";
}

/** Snapshot chosen for retry/replay after a compaction-related timeout. */
type SnapshotSelection = {
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  source: "pre-compaction" | "current";
};

const CONTINUABLE_MESSAGE_ROLES = new Set([
  "user",
  "toolResult",
  "branchSummary",
  "compactionSummary",
  "custom",
  "bashExecution",
]);

export function canContinueFromMessage(message: AgentMessage | undefined): boolean {
  if (!message || ("excludeFromContext" in message && message.excludeFromContext === true)) {
    return false;
  }
  return CONTINUABLE_MESSAGE_ROLES.has(message.role);
}

// Drop trailing assistant/tool-call-only fragments before retrying. Those tails
// are not safe continuation points because replay could resume after an
// incomplete action instead of a user, tool-result, or summary boundary.
export function trimToContinuableTail(messages: AgentMessage[]): AgentMessage[] | null {
  const end = messages.findLastIndex(canContinueFromMessage) + 1;
  return end > 0 ? messages.slice(0, end) : null;
}

/**
 * Selects the transcript snapshot used after a compaction timeout. Prefer the
 * pre-compaction view when it can be continued cleanly; otherwise fall back to a
 * trimmed current snapshot so retry does not replay past an unsafe tail.
 */
export function selectCompactionTimeoutSnapshot(params: {
  timedOutDuringCompaction: boolean;
  preCompactionSnapshot: AgentMessage[] | null;
  preCompactionSessionId: string;
  currentSnapshot: AgentMessage[];
  currentSessionId: string;
}): SnapshotSelection {
  if (params.timedOutDuringCompaction && params.preCompactionSnapshot) {
    const continuablePreCompactionSnapshot = trimToContinuableTail(params.preCompactionSnapshot);
    if (continuablePreCompactionSnapshot) {
      return {
        messagesSnapshot: continuablePreCompactionSnapshot,
        sessionIdUsed: params.preCompactionSessionId,
        source: "pre-compaction",
      };
    }
  }

  return {
    messagesSnapshot: params.timedOutDuringCompaction
      ? (trimToContinuableTail(params.currentSnapshot) ?? [])
      : params.currentSnapshot,
    sessionIdUsed: params.currentSessionId,
    source: "current",
  };
}
