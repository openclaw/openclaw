import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** A retained receipt is not a runnable foreground input until its whole cohort is ready. */
export function isRestoredRequesterWakeRunnable(
  entry: SubagentRunRecord,
  rows: Iterable<SubagentRunRecord>,
  pauseNotice: boolean,
): boolean {
  const wake = entry.requesterSettleWake;
  if (
    !wake ||
    (wake.status === "pending" && wake.attemptCount === 0) ||
    entry.collect ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.suppressCompletionDelivery ||
    entry.execution.restartRecovery ||
    entry.terminalOwner === "interrupted-recovery"
  ) {
    return false;
  }
  if (pauseNotice) {
    return entry.pauseReason === "sessions_yield" && Boolean(wake.pauseNotice);
  }
  if (
    entry.pauseReason === "sessions_yield" ||
    entry.execution.status !== "terminal" ||
    entry.execution.endedAt === undefined
  ) {
    return false;
  }
  const inventory = [...rows];
  const visited = new Set<string>();
  const settled = (parent: SubagentRunRecord): boolean => {
    const key = JSON.stringify([parent.childAgentId, parent.childSessionKey]);
    if (visited.has(key)) {
      return false;
    }
    visited.add(key);
    const children = inventory.filter(
      (child) =>
        child.requesterSessionKey === parent.childSessionKey &&
        child.requesterAgentId === parent.childAgentId &&
        child.cleanupCompletedAt === undefined,
    );
    return children.every(
      (child) =>
        child.execution.status === "terminal" &&
        child.execution.endedAt !== undefined &&
        child.pauseReason !== "sessions_yield" &&
        !child.execution.restartRecovery &&
        child.terminalOwner !== "interrupted-recovery" &&
        settled(child),
    );
  };
  return settled(entry);
}
