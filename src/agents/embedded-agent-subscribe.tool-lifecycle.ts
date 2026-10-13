import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { recordEmbeddedToolTrajectoryEvent } from "./embedded-agent-subscribe.trajectory.js";
import { buildToolLifecycleErrorResult, prepareToolResult } from "./embedded-agent-tool-results.js";
import type { AgentEvent } from "./runtime/index.js";
import { markToolExecutionNotStarted, type ToolEffectReceipt } from "./tool-effect-receipt.js";
import { consumeTrustedToolNoStartError } from "./tool-result-error.js";

type ToolTerminal = {
  result: unknown;
  readSanitizedResult: () => unknown;
  isError: boolean;
  executedArguments: unknown;
  effectReceipt: ToolEffectReceipt;
};

type EmbeddedToolLifecycleParams<T> = {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  args: unknown;
  replaySafe?: boolean;
  hideFromChannelProgress?: boolean;
  execute: (onImplementationStart: () => void) => Promise<T>;
  onTerminal?: (terminal: ToolTerminal) => void | Promise<void>;
};

export function createEmbeddedToolLifecycleRunner(
  ctx: EmbeddedAgentSubscribeContext,
): <T>(toolParams: EmbeddedToolLifecycleParams<T>) => Promise<T> {
  return async <T>(toolParams: EmbeddedToolLifecycleParams<T>): Promise<T> => {
    ctx.flushAssistantStream();
    const startEvent = {
      type: "tool_execution_start",
      toolName: toolParams.toolName,
      toolCallId: toolParams.toolCallId,
      parentToolCallId: toolParams.parentToolCallId,
      args: toolParams.args,
      replaySafe: toolParams.replaySafe,
      hideFromChannelProgress: toolParams.hideFromChannelProgress,
      lifecycleProvenance: "nested",
    } as const;
    recordEmbeddedToolTrajectoryEvent(ctx, startEvent, undefined);
    await handleToolExecutionStart(ctx, startEvent);
    let executionStarted = false;
    const finishToolLifecycle = async (
      isError: boolean,
      result: unknown,
    ): Promise<ToolTerminal> => {
      const wasExecuted = executionStarted;
      ctx.flushAssistantStream();
      const endEvent: Extract<AgentEvent, { type: "tool_execution_end" }> = {
        type: "tool_execution_end",
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        isError,
        executionStarted: wasExecuted,
        result,
        hideFromChannelProgress: toolParams.hideFromChannelProgress,
      };
      const readSanitizedResult = prepareToolResult(result);
      recordEmbeddedToolTrajectoryEvent(ctx, endEvent, readSanitizedResult);
      const terminal = await handleToolExecutionEnd(ctx, endEvent, readSanitizedResult);
      return {
        result,
        readSanitizedResult,
        isError: terminal.isError,
        executedArguments: terminal.executedArguments ?? toolParams.args,
        effectReceipt: terminal.effectReceipt,
      };
    };
    let completedResult: T;
    try {
      completedResult = await toolParams.execute(() => {
        executionStarted = true;
      });
    } catch (error) {
      const trustedNoStart = consumeTrustedToolNoStartError(error);
      const result = buildToolLifecycleErrorResult(error);
      if (trustedNoStart) {
        markToolExecutionNotStarted(result);
      }
      const terminal = await finishToolLifecycle(true, result);
      await toolParams.onTerminal?.(terminal);
      throw error;
    }
    const terminal = await finishToolLifecycle(false, completedResult);
    await toolParams.onTerminal?.(terminal);
    return completedResult;
  };
}
