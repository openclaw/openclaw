import type { AgentMessage } from "../../runtime/index.js";

/**
 * Compact state used when the normal run timeout fires. Compaction can be
 * pending, retrying, or actively running, and all three states need the same
 * timeout-grace decision without exposing compaction internals to attempt.ts.
 */
export type CompactionTimeoutSignal = {
  isTimeout: boolean;
  isCompactionPendingOrRetrying: boolean;
  isCompactionInFlight: boolean;
};

/**
 * Marks timeouts that overlap compaction work so callers can log the distinct
 * "waiting for compaction" state instead of treating the run as ordinary idle.
 */
export function shouldFlagCompactionTimeout(signal: CompactionTimeoutSignal): boolean {
  if (!signal.isTimeout) {
    return false;
  }
  return signal.isCompactionPendingOrRetrying || signal.isCompactionInFlight;
}

/**
 * Allows one timeout extension while compaction may still produce a smaller
 * transcript. A second timeout aborts so stuck compaction cannot keep the run
 * alive indefinitely.
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

export function resolveRunTimeoutWithCompactionGraceMs(params: {
  runTimeoutMs: number;
  compactionTimeoutMs: number;
}): number {
  return params.runTimeoutMs + params.compactionTimeoutMs;
}

/**
 * Candidate transcript snapshots available after a timeout interrupts
 * compaction. The pre-compaction snapshot may be older but can be safer when
 * the current transcript ends with half-written assistant/tool-call state.
 */
export type SnapshotSelectionParams = {
  timedOutDuringCompaction: boolean;
  preCompactionSnapshot: AgentMessage[] | null;
  preCompactionSessionId: string;
  currentSnapshot: AgentMessage[];
  currentSessionId: string;
};

/** Chosen transcript snapshot and the session id that owns it. */
export type SnapshotSelection = {
  messagesSnapshot: AgentMessage[];
  sessionIdUsed: string;
  source: "pre-compaction" | "current";
};

function canContinueFromMessage(message: AgentMessage | undefined): boolean {
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

/**
 * Picks the transcript snapshot used for timeout recovery. On compaction
 * timeouts, it prefers the pre-compaction snapshot but trims non-continuable
 * assistant/tool-call tails so the next attempt does not replay an incomplete
 * model turn.
 */
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
