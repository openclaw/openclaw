import {
  getSubagentRunsForChildSession,
  getSubagentRunsForRequesterSession,
  subagentRuns,
} from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  recordLatestSubagentRun,
} from "./subagent-run-generation.js";
import {
  hasSubagentRunEnded,
  isSubagentRunLive,
  isSubagentRunQueued,
} from "./subagent-run-liveness.js";

export type SubagentExecutionObservation = {
  state: "queued" | "running" | "waiting" | "finished" | "unknown";
  wait?: {
    kind: "children" | "external";
    dependencies?: Array<{ runId: string; sessionKey: string; label?: string }>;
    pendingCount?: number;
  };
};

function isYieldedSubagentRun(entry: SubagentRunRecord): boolean {
  return (
    entry.pauseReason === "sessions_yield" &&
    !entry.killIntent &&
    !entry.killReconciliation &&
    entry.suppressAnnounceReason !== "killed" &&
    entry.endedReason !== "subagent-killed"
  );
}

/** Project recorded execution separately from completion and requester delivery. */
export function observeSubagentExecution(
  entry: SubagentRunRecord,
  children: Iterable<SubagentRunRecord>,
): SubagentExecutionObservation {
  if (isYieldedSubagentRun(entry)) {
    const latestChildren = new Map<string, SubagentRunRecord>();
    for (const child of children) {
      if (child.requesterSessionKey === entry.childSessionKey) {
        recordLatestSubagentRun(latestChildren, child.childSessionKey, child);
      }
    }
    const pending = [...latestChildren.values()]
      .filter(
        (child) =>
          child.collect !== true &&
          child.expectsCompletionMessage === true &&
          child.suppressAnnounceReason !== "steer-restart" &&
          (isYieldedSubagentRun(child) ||
            !hasSubagentRunEnded(child) ||
            child.requesterSettleWake !== undefined ||
            typeof child.cleanupCompletedAt !== "number"),
      )
      .toSorted((left, right) => left.runId.localeCompare(right.runId));
    return {
      state: "waiting",
      wait:
        pending.length > 0
          ? {
              kind: "children",
              pendingCount: pending.length,
              dependencies: pending
                .slice(0, 32)
                .map((child) =>
                  Object.assign(
                    { runId: child.runId, sessionKey: child.childSessionKey },
                    child.label ? { label: child.label } : {},
                  ),
                ),
            }
          : { kind: "external" },
    };
  }
  if (hasSubagentRunEnded(entry)) {
    return { state: "finished" };
  }
  if (entry.execution.status === "interrupted") {
    return { state: "unknown" };
  }
  // Snapshots must match the current registration before using live or queued ownership.
  const current = subagentRuns.get(entry.runId);
  if (
    !current ||
    current.childSessionKey !== entry.childSessionKey ||
    current.requesterSessionKey !== entry.requesterSessionKey ||
    (current.taskRunId ?? current.runId) !== (entry.taskRunId ?? entry.runId) ||
    compareSubagentRunGeneration(current, entry) !== 0
  ) {
    return { state: "unknown" };
  }
  if (isSubagentRunLive(current)) {
    return { state: current.execution.status === "queued" ? "queued" : "running" };
  }
  if (isSubagentRunQueued(current)) {
    return { state: "queued" };
  }
  return { state: "unknown" };
}

/** Observe only the current memory owner of this exact delegated task. */
export function getSubagentExecutionObservation(params: {
  taskRunId: string;
  childSessionKey: string;
  generation?: number;
}): (SubagentExecutionObservation & { executionRunId: string }) | undefined {
  let owner: SubagentRunRecord | undefined;
  for (const entry of getSubagentRunsForChildSession(params.childSessionKey)) {
    if (!owner || compareSubagentRunGeneration(entry, owner) > 0) {
      owner = entry;
    }
  }
  if (
    !owner ||
    (owner.taskRunId ?? owner.runId) !== params.taskRunId ||
    (params.generation !== undefined && owner.generation !== params.generation)
  ) {
    return undefined;
  }
  return {
    ...observeSubagentExecution(owner, getSubagentRunsForRequesterSession(owner.childSessionKey)),
    executionRunId: owner.runId,
  };
}
