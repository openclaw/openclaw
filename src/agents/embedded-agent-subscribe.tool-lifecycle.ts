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

type EmbeddedToolLifecycleRunner = <T>(toolParams: EmbeddedToolLifecycleParams<T>) => Promise<T>;

export function createEmbeddedToolLifecycleRunner(
  ctx: EmbeddedAgentSubscribeContext,
): EmbeddedToolLifecycleRunner {
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
    const onImplementationStart = () => {
      executionStarted = true;
    };
    let completedResult: T;
    try {
      completedResult = await toolParams.execute(onImplementationStart);
    } catch (error) {
      const trustedNoStart = consumeTrustedToolNoStartError(error);
      const result = buildToolLifecycleErrorResult(error);
      if (trustedNoStart) {
        markToolExecutionNotStarted(result);
      }
      const terminal = await finishToolLifecycle(ctx, toolParams, {
        executionStarted,
        isError: true,
        result,
      });
      await toolParams.onTerminal?.(terminal);
      throw error;
    }
    const terminal = await finishToolLifecycle(ctx, toolParams, {
      executionStarted,
      isError: false,
      result: completedResult,
    });
    await toolParams.onTerminal?.(terminal);
    return completedResult;
  };
}

async function finishToolLifecycle(
  ctx: EmbeddedAgentSubscribeContext,
  toolParams: EmbeddedToolLifecycleParams<unknown>,
  outcome: { executionStarted: boolean; isError: boolean; result: unknown },
): Promise<ToolTerminal> {
  ctx.flushAssistantStream();
  const endEvent: Extract<AgentEvent, { type: "tool_execution_end" }> = {
    type: "tool_execution_end",
    toolName: toolParams.toolName,
    toolCallId: toolParams.toolCallId,
    isError: outcome.isError,
    executionStarted: outcome.executionStarted,
    result: outcome.result,
    hideFromChannelProgress: toolParams.hideFromChannelProgress,
  };
  const readSanitizedResult = prepareToolResult(outcome.result);
  recordEmbeddedToolTrajectoryEvent(ctx, endEvent, readSanitizedResult);
  const terminal = await handleToolExecutionEnd(ctx, endEvent, readSanitizedResult);
  return {
    result: outcome.result,
    readSanitizedResult,
    isError: terminal.isError,
    executedArguments: terminal.executedArguments ?? toolParams.args,
    effectReceipt: terminal.effectReceipt,
  };
}
