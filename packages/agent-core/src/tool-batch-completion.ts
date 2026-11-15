import type { AssistantMessage } from "@openclaw/llm-core";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type {
  ExecutedToolCallOutcome,
  FinalizedToolCallEntry,
  StartedToolCall,
} from "./agent-loop-tool-execution.js";
import type { ExecutedToolCallBatch } from "./agent-stream-response.js";
import { getInternalToolTurnInputScope } from "./internal-hooks.js";
import type { FinalizedToolCallOutcome } from "./tool-call-outcome.js";
import type { AgentLoopConfig } from "./types.js";

/** Keep the initiating failure primary without dropping later accepted work's outcome. */
export function mergeToolExecutionFailure(
  current: ExecutedToolCallBatch["fatal"],
  error: unknown,
): NonNullable<ExecutedToolCallBatch["fatal"]> {
  if (!current) {
    return { error };
  }
  if (current.error === error) {
    return current;
  }
  let message = "Tool execution failed";
  try {
    message = coerceErrorMessage(current.error);
  } catch {
    // A diagnostic getter must not replace either accepted outcome.
  }
  return { error: new AggregateError([current.error, error], message, { cause: current.error }) };
}

export function mergeRejectedToolOutcomes(
  primary: ExecutedToolCallBatch["fatal"],
  outcomes: readonly PromiseSettledResult<unknown>[],
): ExecutedToolCallBatch["fatal"] {
  let failure = primary;
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      failure = mergeToolExecutionFailure(failure, outcome.reason);
    }
  }
  return failure;
}

/** Drain before disposal; an existing fatal alone still follows normal batch completion. */
export async function drainToolCallGroup(
  started: readonly StartedToolCall[],
  entries: readonly FinalizedToolCallEntry[],
  primary: ExecutedToolCallBatch["fatal"],
  settle: (call: StartedToolCall, outcome: ExecutedToolCallOutcome) => Promise<void>,
): Promise<ExecutedToolCallBatch["fatal"]> {
  let failure: ExecutedToolCallBatch["fatal"];
  if (started.length > 0) {
    const outcomes = await Promise.allSettled(
      started.map(async (call) => ({ call, result: await call.outcome })),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        failure = mergeToolExecutionFailure(failure ?? primary, outcome.reason);
      } else {
        try {
          await settle(outcome.value.call, outcome.value.result);
        } catch (error) {
          failure = mergeToolExecutionFailure(failure ?? primary, error);
        }
      }
    }
  }
  for (const entry of entries) {
    if ("kind" in entry) {
      try {
        entry.execution.dispose();
      } catch (error) {
        failure = mergeToolExecutionFailure(failure ?? primary, error);
      }
    }
  }
  return failure;
}

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
  let fatal: ExecutedToolCallBatch["fatal"];
  for (const batch of batches) {
    if (batch.fatal) {
      fatal = mergeToolExecutionFailure(fatal, batch.fatal.error);
    }
  }
  // Completion also commits finalized host replies; run it even if every tool
  // already requested termination.
  const complete = config.completesToolTurn;
  let completesToolTurn: boolean;
  try {
    completesToolTurn =
      complete?.({
        message,
        toolResults: messages,
        terminalToolCallIds: new Set(terminalToolCallIds),
        inputScope: getInternalToolTurnInputScope(complete),
      }) === true;
  } catch (error) {
    throw mergeToolExecutionFailure(fatal, error).error;
  }
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
    fatal,
  };
}
