import type { SessionEntry } from "../../../config/sessions.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function isTerminalFailedSubagentRestartRecovery(entry: SubagentRunRecord): boolean {
  return (
    entry.terminalOwner === "interrupted-recovery" &&
    entry.endedReason === "subagent-error" &&
    entry.execution.status === "terminal" &&
    entry.execution.outcome?.status === "error" &&
    typeof entry.execution.endedAt === "number" &&
    entry.execution.interruptionReason === undefined
  );
}

/** Restart custody survives the process; explicit cancellation never supplies it. */
export function isRestartInterruptedSubagent(
  entry: SubagentRunRecord,
  options?: { allowTerminalFailure: true },
): boolean {
  return (
    (entry.execution.interruptionReason === "gateway-restart" ||
      (options?.allowTerminalFailure === true && isTerminalFailedSubagentRestartRecovery(entry))) &&
    !entry.killIntent &&
    !entry.killReconciliation &&
    !entry.pauseReason &&
    !entry.suppressCompletionDelivery &&
    !entry.execution.suppressSessionEffects
  );
}

export function isQuietSubagentRestartContinuation(entry: SubagentRunRecord): boolean {
  return (
    !entry.collect &&
    entry.expectsCompletionMessage === false &&
    entry.completionTarget === "parent" &&
    (entry.execution.interruptionReason === "gateway-restart" ||
      isTerminalFailedSubagentRestartRecovery(entry))
  );
}

export function shouldSuppressSubagentRecoverySessionEffects(entry: SubagentRunRecord): boolean {
  if (resolveSubagentChildAuthority(entry).status !== "verified") {
    return true;
  }
  if (entry.execution.suppressSessionEffects === true) {
    return true;
  }
  if (entry.killIntent) {
    const killLifecycleGeneration = entry.killIntent.lifecycleGeneration;
    return (
      typeof killLifecycleGeneration !== "string" ||
      killLifecycleGeneration.length === 0 ||
      !isAgentEventLifecycleGenerationCurrent(killLifecycleGeneration)
    );
  }
  const lifecycleGeneration = entry.execution.restartRecovery?.lifecycleGeneration;
  return (
    typeof lifecycleGeneration === "string" &&
    lifecycleGeneration.length > 0 &&
    !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
  );
}

export function isSubagentRecoveryWedgedEntry(entry: unknown): boolean {
  const recovery =
    entry && typeof entry === "object" ? (entry as SessionEntry).subagentRecovery : undefined;
  return (
    typeof recovery?.wedgedAt === "number" &&
    Number.isFinite(recovery.wedgedAt) &&
    recovery.wedgedAt > 0
  );
}

export function formatSubagentRecoveryWedgedReason(entry: SessionEntry): string {
  return (
    entry.subagentRecovery?.wedgedReason?.trim() ||
    "subagent orphan recovery is tombstoned for this session"
  );
}

export function clearWedgedSubagentRecoveryAbort(entry: SessionEntry, now: number): boolean {
  if (!isSubagentRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) {
    return false;
  }
  entry.abortedLastRun = false;
  entry.updatedAt = now;
  return true;
}
