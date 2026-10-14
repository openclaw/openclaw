import type { AssistantMessage } from "@openclaw/llm-core";
import type { ExecutedToolCallBatch } from "./agent-stream-response.js";
import type { FinalizedToolCallOutcome } from "./tool-call-outcome.js";
import type { AgentLoopConfig } from "./types.js";

export function resolveToolBatchTermination(finalizedCalls: FinalizedToolCallOutcome[]) {
  const terminalToolCallIds = finalizedCalls
    .filter((finalized) => finalized.result.terminate === true)
    .map((finalized) => finalized.toolCall.id);
  return {
    terminate: finalizedCalls.length > 0 && terminalToolCallIds.length === finalizedCalls.length,
    terminalToolCallIds,
  };
}

/**
 * Combines the tool batches one assistant message ran (streamed batches first, then
 * the terminal batch). The turn ends when every result asked to terminate, or when
 * OpenClaw's turn-completion hook says the settled results complete the turn.
 */
export function combineExecutedToolBatches(
  config: Pick<AgentLoopConfig, "completesToolTurn">,
  message: AssistantMessage,
  batches: readonly ExecutedToolCallBatch[],
): ExecutedToolCallBatch {
  const messages = batches.flatMap((batch) => batch.messages);
  const terminalToolCallIds = batches.flatMap((batch) => batch.terminalToolCallIds);
  // Completion also commits finalized host replies; run it even if every tool
  // already requested termination.
  const completesToolTurn =
    config.completesToolTurn?.({
      message,
      toolResults: messages,
      terminalToolCallIds: new Set(terminalToolCallIds),
    }) === true;
  const terminate = batches.every((batch) => batch.terminate) || completesToolTurn;
  const terminatingBatch = batches.find((batch) => batch.terminateRun);
  return {
    messages,
    terminalToolCallIds,
    steeringMessages: [...new Set(batches.flatMap((batch) => batch.steeringMessages))],
    terminate,
    terminateRun: terminatingBatch !== undefined,
    intervention:
      terminatingBatch?.intervention ?? batches.find((batch) => batch.intervention)?.intervention,
    fatal: batches.find((batch) => batch.fatal)?.fatal,
  };
}
