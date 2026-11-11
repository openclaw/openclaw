import type { ToolResultMessage } from "@openclaw/llm-core";
import type { ToolBatchContext } from "./agent-loop.js";
import {
  emitToolExecutionStart,
  emitToolExecutionEnd,
  emitToolResultMessage,
  type ExecutedToolCallBatch,
} from "./agent-stream-response.js";
import { copyInternalToolResultState } from "./internal-hooks.js";
import { resolveToolBatchTermination } from "./tool-batch-completion.js";
import {
  finalizeToolCallOutcome,
  hidesToolCallFromChannelProgress,
  type FinalizedToolCallOutcome,
} from "./tool-call-outcome.js";
import type { AgentToolCall, ToolLoopIntervention, ToolLoopRecoveryState } from "./types.js";

export function resetToolLoopRecovery(state: ToolLoopRecoveryState): void {
  state.criticalToolLoopSeen = false;
  delete state.repeatedToolError;
  delete state.blockedToolActions;
}

/** Repeated tool errors in one unseen response share the same recovery allowance. */
export function advanceToolLoopRecovery(
  batch: ToolBatchContext,
  intervention: ToolLoopIntervention,
): boolean {
  if (batch.toolPlan.terminalIntervention) {
    return true;
  }
  if (
    intervention.detector === "repeated_tool_error" &&
    batch.toolPlan.repeatedToolErrorRecoveryGranted
  ) {
    return false;
  }
  const terminal = batch.toolLoopRecoveryState.criticalToolLoopSeen;
  batch.toolLoopRecoveryState.criticalToolLoopSeen = true;
  if (terminal) {
    batch.toolPlan.terminalIntervention = intervention;
    if (intervention.detector === "repeated_tool_error") {
      batch.onTerminalLoop?.();
    }
  } else if (intervention.detector === "repeated_tool_error") {
    batch.toolPlan.repeatedToolErrorRecoveryGranted = true;
  }
  return terminal;
}

export async function completeToolLoopInterventionBatch(
  batch: ToolBatchContext,
  params: {
    toolCalls: AgentToolCall[];
    intervention: ToolLoopIntervention;
    terminal: boolean;
  },
): Promise<ExecutedToolCallBatch> {
  const messages: ToolResultMessage[] = [];
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  if (params.intervention.detector === "repeated_tool_error") {
    await batch.waitForPrevious?.();
  }
  for (const toolCall of params.toolCalls) {
    const hideFromChannelProgress = hidesToolCallFromChannelProgress(batch, toolCall);
    await emitToolExecutionStart(batch, toolCall, hideFromChannelProgress);
    const isTrigger = toolCall.id === params.intervention.toolCallId;
    const text = params.terminal
      ? isTrigger
        ? `${params.intervention.reason}\n\nCritical tool-loop recovery failed because another critical loop was detected. This run is stopping now.`
        : "This tool was not executed because another call in the batch repeated a critical tool loop. This run is stopping now."
      : isTrigger
        ? `${params.intervention.recoveryMessage ?? params.intervention.reason}\n\nDo not repeat this exact tool action. Reassess the task. You may answer the user, ask for clarification, or continue with a different tool or different arguments.`
        : "This tool was not executed because another call in the batch triggered critical tool-loop recovery. Reassess the task before choosing the next action.";
    const validation = batch.validated.get(toolCall);
    // Rejected calls never start executing, so they must not inherit the
    // resolved tool's result content source; that metadata is only truthful
    // after execution starts and would otherwise taint the recovery turn.
    const finalized = await finalizeToolCallOutcome(
      batch,
      {
        toolCall,
        result: {
          content: [{ type: "text", text }],
          details: {
            status: "blocked",
            deniedReason: "tool-loop",
            intervention: params.intervention,
          },
          ...(params.terminal ? { terminate: true } : {}),
        },
        isError: true,
        executionStarted: false,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
      validation?.kind === "prepared" ? validation.args : toolCall.arguments,
    );
    await emitToolExecutionEnd(finalized, batch);
    messages.push(await emitToolResultMessage(finalized, batch.emit));
    finalizedCalls.push(finalized);
  }
  const termination = resolveToolBatchTermination(finalizedCalls);
  return {
    messages,
    steeringMessages: [],
    ...termination,
    // A later critical loop always forces termination. During first recovery,
    // honor the outcome hooks: if every finalized outcome says terminate, the
    // batch ends without another provider turn.
    terminate: params.terminal || termination.terminate,
    terminateRun: params.terminal,
    intervention: params.intervention,
  };
}

export function appendToolLoopRecoveryNote(
  finalized: FinalizedToolCallOutcome,
  intervention: ToolLoopIntervention,
): FinalizedToolCallOutcome {
  return {
    ...finalized,
    result: copyInternalToolResultState(finalized.result, {
      ...finalized.result,
      content: [
        ...(finalized.result.content ?? []),
        {
          type: "text",
          text:
            "[System note: " +
            (intervention.recoveryMessage ?? intervention.reason) +
            " Do not repeat this exact tool action. If it may have partly applied, check current state first. Reassess: change the tool or arguments, ask the user, or answer without it.]",
        },
      ],
    }),
  };
}
