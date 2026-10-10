import type { AssistantMessage } from "@openclaw/llm-core";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  appendToolLoopWarning,
  copyInternalToolResultState,
  type InternalToolBatchLifecycle,
} from "./internal-hooks.js";
import type {
  AfterToolOutcomeContext,
  AgentContext,
  AgentLoopConfig,
  AgentToolCall,
  AgentToolResult,
  ToolLoopWarning,
  ToolResultContentSource,
} from "./types.js";

type ToolOutcomeContext = {
  assistantMessage: AssistantMessage;
  currentContext: AgentContext;
  config: Pick<AgentLoopConfig, "afterToolOutcome">;
  signal: AbortSignal | undefined;
  warnings?: ToolLoopWarning[];
  lifecycle?: Pick<InternalToolBatchLifecycle, "observeOutcome">;
};

export type FinalizedToolCallOutcome = {
  loopOutcome?: Pick<AfterToolOutcomeContext, "toolCall" | "args" | "result" | "isError">;
  toolCall: AgentToolCall;
  result: AgentToolResult<unknown>;
  isError: boolean;
  executionStarted: boolean;
  errorKind?: "argument-validation";
  hideFromChannelProgress?: boolean;
  resultContentSource?: ToolResultContentSource;
};

export async function finalizeToolCallOutcome(
  batch: ToolOutcomeContext,
  finalized: FinalizedToolCallOutcome,
  args: unknown,
): Promise<FinalizedToolCallOutcome> {
  const outcome = await applyToolOutcomeHook(batch, finalized, args);
  if (batch.lifecycle?.observeOutcome) {
    outcome.loopOutcome = {
      toolCall: outcome.toolCall,
      args,
      result: outcome.result,
      isError: outcome.isError,
    };
  }
  const warning = batch.warnings?.find((entry) => entry.toolCallId === outcome.toolCall.id);
  return warning ? { ...outcome, result: appendToolLoopWarning(outcome.result, warning) } : outcome;
}

async function applyToolOutcomeHook(
  batch: ToolOutcomeContext,
  finalized: FinalizedToolCallOutcome,
  args: unknown,
): Promise<FinalizedToolCallOutcome> {
  if (!batch.config.afterToolOutcome) {
    return finalized;
  }
  try {
    const afterResult = await batch.config.afterToolOutcome(
      {
        assistantMessage: batch.assistantMessage,
        toolCall: finalized.toolCall,
        args,
        result: finalized.result,
        isError: finalized.isError,
        executionStarted: finalized.executionStarted,
        ...(finalized.errorKind ? { errorKind: finalized.errorKind } : {}),
        context: batch.currentContext,
      },
      batch.signal,
    );
    if (!afterResult) {
      return finalized;
    }
    return {
      ...finalized,
      result: copyInternalToolResultState(finalized.result, {
        ...finalized.result,
        content: afterResult.content ?? finalized.result.content,
        details: afterResult.details ?? finalized.result.details,
        terminate: afterResult.terminate ?? finalized.result.terminate,
      }),
      isError: afterResult.isError ?? finalized.isError,
    };
  } catch (error) {
    const errorResult = createErrorToolResult(coerceErrorMessage(error));
    return {
      ...finalized,
      result: {
        ...errorResult,
        ...(finalized.result.terminate === undefined
          ? {}
          : { terminate: finalized.result.terminate }),
      },
      isError: true,
    };
  }
}

export type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult<unknown>;
  isError: boolean;
  errorKind?: "argument-validation";
};

export function immediateToolCallError(message: string): ImmediateToolCallOutcome {
  return { kind: "immediate", result: createErrorToolResult(message), isError: true };
}

export function createToolExecutionErrorResult(error: unknown): AgentToolResult<unknown> {
  const result = createErrorToolResult(coerceErrorMessage(error));
  return typeof error === "object" && error !== null
    ? copyInternalToolResultState(error, result)
    : result;
}

export function createErrorToolResult(
  message: string,
  details: unknown = {},
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details,
  };
}
