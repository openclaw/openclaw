import type { AssistantMessage } from "@openclaw/llm-core";
import type { ExecutedToolCallBatch } from "./agent-stream-response.js";
import type { AgentLoopConfig } from "./types.js";

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
  const terminate =
    batches.every((batch) => batch.terminate) ||
    config.completesToolTurn?.({ message, toolResults: messages }) === true;
  const terminatingBatch = batches.find((batch) => batch.terminateRun);
  return {
    messages,
    steeringMessages: [...new Set(batches.flatMap((batch) => batch.steeringMessages))],
    terminate,
    terminateRun: terminatingBatch !== undefined,
    intervention:
      terminatingBatch?.intervention ?? batches.find((batch) => batch.intervention)?.intervention,
    fatal: batches.find((batch) => batch.fatal)?.fatal,
  };
}
