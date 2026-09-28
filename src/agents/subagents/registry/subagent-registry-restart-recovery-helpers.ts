import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import * as agentEvents from "../../../infra/agent-events.js";
import type {
  SubagentRestartRecoveryReceipt,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export function getRestartRecoveryReplayError(entry: SubagentRunRecord): string | undefined {
  return entry.terminalOwner !== "interrupted-recovery" ||
    entry.pauseReason === "sessions_yield" ||
    entry.execution.status !== "terminal" ||
    typeof entry.execution.endedAt !== "number" ||
    entry.execution.outcome?.status !== "error" ||
    entry.endedReason !== "subagent-error"
    ? undefined
    : (entry.execution.outcome.error ?? "subagent run interrupted by gateway restart");
}

export function isRestartRecoveryLifecycleCurrent(
  receipt: SubagentRestartRecoveryReceipt,
): boolean {
  return (
    !receipt.lifecycleGeneration ||
    agentEvents.isAgentEventLifecycleGenerationCurrent(receipt.lifecycleGeneration)
  );
}

export function isRetiredSubagentExecution(entry: SubagentRunRecord): boolean {
  return (
    (entry.execution.status === "running" || entry.execution.status === "interrupted") &&
    typeof entry.execution.lifecycleGeneration === "string" &&
    !agentEvents.isAgentEventLifecycleGenerationCurrent(entry.execution.lifecycleGeneration)
  );
}

export function isRetiredSubagentSessionOwner(
  entry: SubagentRunRecord,
  session: InternalSessionEntry | undefined,
): session is InternalSessionEntry {
  return (
    session?.status === "running" &&
    isRetiredSubagentExecution(entry) &&
    ownsSubagentSessionExecution(entry, session)
  );
}

export function ownsSubagentSessionExecution(
  entry: SubagentRunRecord,
  session: InternalSessionEntry,
): boolean {
  return (
    session.lifecycleRunId === entry.runId ||
    // Internal recovery preserves the visible lifecycle; its accepted marker binds the successor.
    (entry.execution.transcriptTarget !== undefined &&
      entry.taskRunId !== undefined &&
      session.lifecycleRunId ===
        (session.subagentRecovery?.sessionLifecycleRunId ?? entry.taskRunId) &&
      session.subagentRecovery?.lastRunId === entry.runId)
  );
}
