import { isAgentRunWaitingForCapacity } from "../../../infra/agent-run-capacity-wait.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isSameSubagentRun, recordLatestSubagentRun } from "./subagent-run-generation.js";
import {
  hasSubagentRunEnded,
  isSubagentRunLive,
  isSubagentRunQueued,
} from "./subagent-run-liveness.js";

export type SubagentExecutionObservation = {
  state: "queued" | "running" | "waiting" | "finished" | "unknown";
  currentTool?: { name: string };
  wait?: {
    kind: "approval" | "user_input" | "agent_messages" | "children" | "external";
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
  // Data-only snapshots may observe matching current execution, but carry no callback custody.
  const current = subagentRuns.get(entry.runId);
  if (!current || !isSameSubagentRun(current, entry)) {
    return { state: "unknown" };
  }
  if (isSubagentRunLive(current)) {
    if (current.execution.status === "queued" || isAgentRunWaitingForCapacity(current.runId)) {
      return { state: "queued" };
    }
    const context = getAgentRunContext(current.runId);
    const activity =
      context?.sessionKey === current.childSessionKey ? context.executionActivity : undefined;
    if (activity?.approvalOverflow) {
      return { state: "unknown" };
    }
    if (activity?.pendingApprovalIds.length) {
      return { state: "waiting", wait: { kind: "approval" } };
    }
    if (activity?.execution?.state === "unknown") {
      return { state: "unknown" };
    }
    if (activity?.execution?.state === "waiting") {
      return { state: "waiting", wait: { kind: activity.execution.wait ?? "external" } };
    }
    const tool = activity?.tools.at(-1);
    return { state: "running", ...(tool ? { currentTool: { name: tool.name } } : {}) };
  }
  if (isSubagentRunQueued(current)) {
    return { state: "queued" };
  }
  return { state: "unknown" };
}
