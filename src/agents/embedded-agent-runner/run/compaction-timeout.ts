import type { AgentMessage } from "../../runtime/index.js";

/**
 * Timeout state sampled when an attempt exits. `isTimeout` is the trigger,
 * while the compaction flags explain whether the timeout should be reported as
 * compaction-related instead of a plain model/tool timeout.
 */
export type CompactionTimeoutSignal = {
  isTimeout: boolean;
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
};

/** Returns true when a run timeout should be attributed to compaction work. */
export function shouldFlagCompactionTimeout(signal: CompactionTimeoutSignal): boolean {
  if (!signal.isTimeout) {
    return false;
  }
  return signal.isCompactionPendingOrRetrying || signal.isCompactionInFlight;
}

/** Decides whether a run timeout gets one compaction grace window or aborts immediately. */
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

/** Combines the normal run timeout with the one-time compaction grace budget. */
export function resolveRunTimeoutWithCompactionGraceMs(params: {
  runTimeoutMs: number;
  compactionTimeoutMs: number;
}): number {
  return params.runTimeoutMs + params.compactionTimeoutMs;
}

/**
 * Candidate transcript snapshots used when compaction times out mid-rewrite.
 * The pre-compaction snapshot is preferred because the current transcript may
 * include a partial summary or assistant tail that is unsafe for retry.
 */
export type SnapshotSelectionParams = {
  timedOutDuringCompaction: boolean;
  preCompactionSnapshot: AgentMessage[] | null;
  preCompactionSessionId: string;
  currentSnapshot: AgentMessage[];
  currentSessionId: string;
};

/** Transcript selected for retry after trimming to a continuable tail. */
export type SnapshotSelection = {
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  source: "pre-compaction" | "current";
};

function canContinueFromMessage(message: AgentMessage | undefined): boolean {
  // Continuations must resume from a transcript tail that can accept a new model
  // turn; dangling assistant/tool-call rows would corrupt retry context.
  switch (message?.role) {
    case "user":
    case "toolResult":
    case "branchSummary":
    case "compactionSummary":
    case "custom":
      return true;
    case "bashExecution":
      return message.excludeFromContext !== true;
    default:
      return false;
  }
}

function trimToContinuableTail(messages: AgentMessage[]): AgentMessage[] | null {
  let end = messages.length;
  while (end > 0 && !canContinueFromMessage(messages[end - 1])) {
    end -= 1;
  }
  return end > 0 ? messages.slice(0, end) : null;
}

/** Chooses the safest transcript snapshot after a timeout interrupts compaction. */
export function selectCompactionTimeoutSnapshot(
  params: SnapshotSelectionParams,
): SnapshotSelection {
  if (!params.timedOutDuringCompaction) {
    return {
      messagesSnapshot: params.currentSnapshot,
      sessionIdUsed: params.currentSessionId,
      source: "current",
    };
  }

  if (params.preCompactionSnapshot) {
    // Prefer the pre-compaction transcript so the retry does not inherit a
    // partial summary that may have been written by the timed-out compactor.
    const continuablePreCompactionSnapshot = trimToContinuableTail(params.preCompactionSnapshot);
    if (continuablePreCompactionSnapshot) {
      return {
        messagesSnapshot: continuablePreCompactionSnapshot,
        sessionIdUsed: params.preCompactionSessionId,
        source: "pre-compaction",
      };
    }
  }

  const continuableCurrentSnapshot = trimToContinuableTail(params.currentSnapshot);
  if (continuableCurrentSnapshot) {
    return {
      messagesSnapshot: continuableCurrentSnapshot,
      sessionIdUsed: params.currentSessionId,
      source: "current",
    };
  }

  return {
    messagesSnapshot: [],
    sessionIdUsed: params.currentSessionId,
    source: "current",
  };
}
