import type { AssistantMessage } from "@openclaw/llm-core";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type {
  ExecutedToolCallOutcome,
  PreparedToolCall,
  ReadyPreparedToolCall,
} from "./agent-loop-tool-execution.js";
import {
  emitToolExecutionEnd,
  emitToolExecutionStart,
  type AgentEventSink,
} from "./agent-stream-response.js";
import { ToolArgumentValidationError } from "./errors.js";
import {
  appendToolLoopWarning,
  copyInternalToolResultState,
  getInternalToolResultContentSource,
  type InternalToolBatchLifecycle,
} from "./internal-hooks.js";
import type { AgentCoreStreamRuntimeDeps } from "./runtime-deps.js";
import type {
  AfterToolOutcomeContext,
  AgentContext,
  AgentLoopConfig,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  ToolLoopWarning,
  ToolResultContentSource,
} from "./types.js";

type ToolOutcomeContext = {
  assistantMessage: AssistantMessage;
  currentContext: AgentContext;
  config: Pick<AgentLoopConfig, "afterToolCall" | "afterToolOutcome">;
  isLocalError?: AgentCoreStreamRuntimeDeps["isLocalError"];
  signal: AbortSignal | undefined;
  warnings?: ToolLoopWarning[];
  lifecycle?: Pick<InternalToolBatchLifecycle, "observeOutcome">;
};

export type ResolvedToolCallOutcome =
  | { kind: "resolved"; tool?: AgentTool }
  | { kind: "error"; error: unknown };

export function hidesToolCallFromChannelProgress(
  batch: {
    currentContext: AgentContext;
    resolved: ReadonlyMap<AgentToolCall, ResolvedToolCallOutcome>;
  },
  toolCall: AgentToolCall,
): boolean {
  const resolution = batch.resolved.get(toolCall);
  const tool =
    resolution?.kind === "resolved"
      ? resolution.tool
      : batch.currentContext.tools?.find((candidate) => candidate.name === toolCall.name);
  return tool?.hideFromChannelProgress === true;
}

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

export async function finalizeExecutedToolCall(
  batch: ToolOutcomeContext,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  finalArgs: unknown,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (executed.executionStarted && batch.config.afterToolCall) {
    try {
      const afterResult = await batch.config.afterToolCall(
        {
          assistantMessage: batch.assistantMessage,
          toolCall: prepared.toolCall,
          args: finalArgs,
          result,
          isError,
          context: batch.currentContext,
        },
        batch.signal,
      );
      if (afterResult) {
        result = copyInternalToolResultState(result, {
          ...result,
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        });
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      if (batch.isLocalError?.(error)) {
        throw error;
      }
      result = createErrorToolResult(coerceErrorMessage(error));
      isError = true;
    }
  }

  return await finalizeToolCallOutcome(
    batch,
    {
      toolCall: prepared.toolCall,
      result,
      isError,
      executionStarted: executed.executionStarted,
      ...(prepared.tool.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
      ...(executed.executionStarted && !executed.callerCancelled
        ? resolveToolResultContentSource(prepared.tool, executed.result)
        : {}),
    },
    finalArgs,
  );
}

export async function completeStartedToolCall(
  batch: ToolOutcomeContext & { emit: AgentEventSink },
  entry: ReadyPreparedToolCall,
  outcome: ExecutedToolCallOutcome,
  sequential: boolean,
): Promise<FinalizedToolCallOutcome> {
  try {
    const finalized = await finalizeExecutedToolCall(batch, entry, outcome, entry.execution.args);
    if (sequential) {
      entry.execution.dispose();
    }
    await emitToolExecutionEnd(finalized, batch);
    return finalized;
  } finally {
    entry.execution.dispose();
  }
}

export async function finalizeToolCallOutcome(
  batch: ToolOutcomeContext,
  finalized: FinalizedToolCallOutcome,
  args: unknown,
): Promise<FinalizedToolCallOutcome> {
  let outcome = finalized;
  if (batch.config.afterToolOutcome) {
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
      if (afterResult) {
        outcome = {
          ...finalized,
          result: copyInternalToolResultState(finalized.result, {
            ...finalized.result,
            content: afterResult.content ?? finalized.result.content,
            details: afterResult.details ?? finalized.result.details,
            terminate: afterResult.terminate ?? finalized.result.terminate,
          }),
          isError: afterResult.isError ?? finalized.isError,
        };
      }
    } catch (error) {
      if (batch.isLocalError?.(error)) {
        throw error;
      }
      const errorResult = createErrorToolResult(coerceErrorMessage(error));
      outcome = {
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

export type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult<unknown>;
  isError: boolean;
  errorKind?: "argument-validation";
};

export function immediateToolCallError(message: string): ImmediateToolCallOutcome {
  return { kind: "immediate", result: createErrorToolResult(message), isError: true };
}

export function immediateToolArgumentValidationError(error: unknown): ImmediateToolCallOutcome {
  return {
    ...immediateToolCallError(coerceErrorMessage(error)),
    errorKind: "argument-validation",
  };
}

/** Classify only preparation rejections, not generic or execution failures. */
export function immediateToolPreparationError(error: unknown): ImmediateToolCallOutcome {
  return error instanceof ToolArgumentValidationError
    ? immediateToolArgumentValidationError(error)
    : immediateToolCallError(coerceErrorMessage(error));
}

/**
 * An executed call's source comes from its tool declaration, or from the raw
 * result/error mark a dispatcher (Tool Search, Code Mode) sets for nested calls.
 */
function resolveToolResultContentSource(
  tool: Pick<AgentTool, "resultContentSource">,
  result: object,
): Pick<FinalizedToolCallOutcome, "resultContentSource"> {
  const resultContentSource =
    tool.resultContentSource ?? getInternalToolResultContentSource(result);
  return resultContentSource ? { resultContentSource } : {};
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

const STEERING_TOOL_SKIP_MESSAGE = "Skipped to process an incoming message.";
const TOOL_ADMISSION_FAILURE_MESSAGE = "Tool execution was blocked before launch.";
const TOOL_ADMISSION_FAILURE_DETAILS = {
  status: "blocked",
  deniedReason: "tool-admission",
} as const;

export async function completeUnstartedToolCall(
  batch: ToolOutcomeContext & { emit: AgentEventSink },
  toolCall: AgentToolCall,
  options: {
    args?: unknown;
    reason?: "admission" | "steering";
    startEmitted?: boolean;
    hideFromChannelProgress?: boolean;
  } = {},
): Promise<FinalizedToolCallOutcome> {
  const { hideFromChannelProgress = false } = options;
  if (!options.startEmitted) {
    await emitToolExecutionStart(batch, toolCall, hideFromChannelProgress);
  }
  const finalized = await finalizeToolCallOutcome(
    batch,
    {
      toolCall,
      result: createErrorToolResult(
        options.reason === "admission"
          ? TOOL_ADMISSION_FAILURE_MESSAGE
          : options.reason === "steering"
            ? STEERING_TOOL_SKIP_MESSAGE
            : "Operation aborted",
        options.reason === "admission"
          ? TOOL_ADMISSION_FAILURE_DETAILS
          : options.reason === "steering"
            ? { status: "skipped", deniedReason: "steering" }
            : undefined,
      ),
      isError: true,
      executionStarted: false,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    },
    "args" in options ? options.args : toolCall.arguments,
  );
  await emitToolExecutionEnd(finalized, batch);
  return finalized;
}
