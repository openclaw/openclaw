import type { SessionEntry } from "../../../config/sessions.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Restart custody survives the process; explicit cancellation never supplies it. */
export function isRestartInterruptedSubagent(entry: SubagentRunRecord): boolean {
  return (
    entry.execution.interruptionReason === "gateway-restart" &&
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
    entry.execution.interruptionReason === "gateway-restart"
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
