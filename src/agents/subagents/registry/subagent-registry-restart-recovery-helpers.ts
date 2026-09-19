import { createHash } from "node:crypto";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import * as agentEvents from "../../../infra/agent-events.js";
import { formatSystemTurnPrompt } from "../../../sessions/system-turn-prompt.js";
import { truncateUtf16Safe } from "../../../utils.js";
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

export function buildRestartRecoveryResumeMessage(task: string, lastHumanMessage?: string): string {
  const boundContext = (text: string) =>
    text.length > 2_000 ? `${truncateUtf16Safe(text, 2_000)}...` : text;
  return formatSystemTurnPrompt(
    `Your previous turn was interrupted by a gateway restart. ` +
      `Your original task was:\n\n${boundContext(task)}\n\n` +
      (lastHumanMessage
        ? `The last message from the user before the interruption was:\n\n${boundContext(lastHumanMessage)}\n\n`
        : "") +
      `Please continue where you left off.`,
  );
}

export function buildRestartRecoveryIdempotencyKey(runId: string, sessionMarker: string): string {
  return `subagent-recovery:${createHash("sha256")
    .update(runId)
    .update("\0")
    .update(sessionMarker)
    .digest("hex")}`;
}

export function assertRestartRecoverySnapshotCurrent(params: {
  childSessionKey: string;
  isOwnerCurrent: () => boolean;
  sessionId: string;
  sessionLifecycleRevision?: string;
  sessionLifecycleRunId?: string;
  storePath: string;
  updatedAt: number;
}): void {
  const current = loadSessionEntry({
    storePath: params.storePath,
    sessionKey: params.childSessionKey,
    clone: false,
  });
  if (
    !params.isOwnerCurrent() ||
    current?.sessionId !== params.sessionId ||
    (params.sessionLifecycleRevision !== undefined &&
      current.lifecycleRevision !== params.sessionLifecycleRevision) ||
    current.lifecycleRunId !== params.sessionLifecycleRunId ||
    current.updatedAt !== params.updatedAt ||
    current.abortedLastRun !== true
  ) {
    throw new Error("subagent restart recovery session snapshot changed before dispatch");
  }
}
