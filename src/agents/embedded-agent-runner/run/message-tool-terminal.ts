import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
/**
 * Detects message-tool-only sends that delivered a visible source reply.
 */
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  readMessageToolSourceReplyFinal,
  resolveMessageToolSourceReplyFinal,
} from "../../embedded-agent-message-tool-source-reply.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  Agent,
  AgentTool,
  AgentToolResult,
} from "../../runtime/index.js";

const TERMINAL_SOURCE_REPLY_ALREADY_SENT = {
  status: "suppressed",
  deliveryStatus: "suppressed",
  reason: "message_tool_only_terminal_source_reply_already_sent",
  message: "A terminal source reply was already sent through the message tool for this run.",
} as const;

function createSuppressedTerminalSourceReplyResult(): AgentToolResult<
  typeof TERMINAL_SOURCE_REPLY_ALREADY_SENT
> {
  return {
    content: [{ type: "text", text: JSON.stringify(TERMINAL_SOURCE_REPLY_ALREADY_SENT) }],
    details: TERMINAL_SOURCE_REPLY_ALREADY_SENT,
    terminate: true,
  };
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function argsRecordForToolCall(context: AfterToolCallContext): Record<string, unknown> {
  if (context.args && typeof context.args === "object" && !Array.isArray(context.args)) {
    return context.args as Record<string, unknown>;
  }
  const fallbackArgs = context.toolCall.arguments;
  return fallbackArgs && typeof fallbackArgs === "object" && !Array.isArray(fallbackArgs)
    ? fallbackArgs
    : {};
}

/**
 * Determines whether a `message.send` tool call delivered a visible source reply
 * in message-tool-only delivery mode. Only implicit-route, non-dry-run,
 * delivered sends qualify; explicit routes and errors are not source replies.
 */
function isDeliveredMessageToolOnlySourceReply(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  context: AfterToolCallContext;
  hookResult?: AfterToolCallResult;
}): boolean {
  return isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    toolName: params.context.toolCall.name,
    args: argsRecordForToolCall(params.context),
    result: params.context.result,
    hookResult: params.hookResult,
    isError: params.hookResult?.isError ?? params.context.isError,
  });
}

function isImplicitMessageToolOnlySourceReplySend(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  toolName: string;
  args: unknown;
}): boolean {
  return isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    toolName: params.toolName,
    args: params.args,
    result: {
      content: [
        {
          type: "text",
          text: '{"status":"ok","deliveryStatus":"sent","sourceReplySink":"internal-ui"}',
        },
      ],
      details: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
      },
    },
    isError: false,
  });
}

function isTerminalSourceReplySend(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  toolName: string;
  args: unknown;
}): boolean {
  return (
    isImplicitMessageToolOnlySourceReplySend(params) &&
    resolveMessageToolSourceReplyFinal(argsRecord(params.args).final)
  );
}

/** Installs message-tool-only terminal guards and records source reply delivery evidence. */
export function installMessageToolOnlyTerminalHook(params: {
  agent: Agent;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  onDeliveredSourceReply?: () => void;
  setActiveToolTransform?: (transform: (tools: AgentTool[]) => AgentTool[]) => void;
}): void {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  type TerminalReservationOutcome = "delivered" | "retry";
  let terminalSourceReplyState:
    | {
        kind: "pending";
        toolCallId: string;
        outcome: Promise<TerminalReservationOutcome>;
        settle: (outcome: TerminalReservationOutcome) => void;
      }
    | { kind: "delivered" }
    | undefined;
  const inFlightNonTerminalSends = new Set<Promise<void>>();
  const reserveTerminalSourceReply = (toolCallId: string) => {
    let settle!: (outcome: TerminalReservationOutcome) => void;
    const outcome = new Promise<TerminalReservationOutcome>((resolve) => {
      settle = resolve;
    });
    terminalSourceReplyState = { kind: "pending", toolCallId, outcome, settle };
  };
  const releaseTerminalReservation = (toolCallId: string) => {
    const state = terminalSourceReplyState;
    if (state?.kind === "pending" && state.toolCallId === toolCallId) {
      terminalSourceReplyState = undefined;
      state.settle("retry");
    }
  };
  const markTerminalSourceReplyDelivered = (toolCallId: string) => {
    const state = terminalSourceReplyState;
    terminalSourceReplyState = { kind: "delivered" };
    if (state?.kind === "pending" && state.toolCallId === toolCallId) {
      state.settle("delivered");
    }
  };
  const executeNonTerminalSend = async (
    tool: AgentTool,
    toolCallId: string,
    args: Parameters<AgentTool["execute"]>[1],
    signal: Parameters<AgentTool["execute"]>[2],
    onUpdate: Parameters<AgentTool["execute"]>[3],
  ) => {
    const execution = tool.execute(toolCallId, args, signal, onUpdate);
    const settled = execution.then(
      () => undefined,
      () => undefined,
    );
    inFlightNonTerminalSends.add(settled);
    try {
      return await execution;
    } finally {
      inFlightNonTerminalSends.delete(settled);
    }
  };
  const wrappedTools = new WeakMap<AgentTool, AgentTool>();
  const wrapMessageTool = (tool: AgentTool): AgentTool => {
    if (tool.name !== "message") {
      return tool;
    }
    const cached = wrappedTools.get(tool);
    if (cached) {
      return cached;
    }
    const wrapped: AgentTool = {
      ...tool,
      execute: async (toolCallId, args, signal, onUpdate) => {
        const isImplicitSourceReply = isImplicitMessageToolOnlySourceReplySend({
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          toolName: tool.name,
          args,
        });
        if (!isImplicitSourceReply) {
          return tool.execute(toolCallId, args, signal, onUpdate);
        }
        while (true) {
          const state = terminalSourceReplyState;
          if (state?.kind === "delivered") {
            return createSuppressedTerminalSourceReplyResult();
          }
          if (state?.kind === "pending") {
            await state.outcome;
            continue;
          }
          if (!resolveMessageToolSourceReplyFinal(argsRecord(args).final)) {
            return executeNonTerminalSend(tool, toolCallId, args, signal, onUpdate);
          }

          // Reserve before waiting so later non-terminal sends cannot overtake final.
          reserveTerminalSourceReply(toolCallId);
          await Promise.all(inFlightNonTerminalSends);
          // The agent loop still runs afterToolCall when execute rejects. Keep
          // ownership until that hook classifies any late delivery evidence.
          return await tool.execute(toolCallId, args, signal, onUpdate);
        }
      },
    };
    wrappedTools.set(tool, wrapped);
    wrappedTools.set(wrapped, wrapped);
    return wrapped;
  };
  const transformActiveTools = (tools: AgentTool[]) => tools.map(wrapMessageTool);
  if (params.setActiveToolTransform) {
    params.setActiveToolTransform(transformActiveTools);
  } else {
    const activeTools = params.agent.state?.tools;
    if (activeTools) {
      params.agent.state.tools = transformActiveTools(activeTools);
    }
  }
  const previousResolveDeferredTool = params.agent.resolveDeferredTool?.bind(params.agent);
  if (previousResolveDeferredTool) {
    params.agent.resolveDeferredTool = async (context, signal) => {
      const tool = await previousResolveDeferredTool(context, signal);
      return tool ? wrapMessageTool(tool) : tool;
    };
  }
  const previousShouldStopAfterTurn = params.agent.shouldStopAfterTurn?.bind(params.agent);
  params.agent.shouldStopAfterTurn = async (context) => {
    const previousShouldStop = await previousShouldStopAfterTurn?.(context);
    return terminalSourceReplyState?.kind === "delivered" || previousShouldStop === true;
  };
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const contextArgs = argsRecordForToolCall(context);
    const isTerminalSourceReply = isTerminalSourceReplySend({
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      toolName: context.toolCall.name,
      args: contextArgs,
    });
    const rawDeliveredSourceReply = isDeliveredMessageToolOnlySourceReply({
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      context,
    });
    const rawSourceReplyFinal =
      readMessageToolSourceReplyFinal(context.result) ?? isTerminalSourceReply;
    let hookResult: AfterToolCallResult | undefined;
    try {
      hookResult = await previousAfterToolCall?.(context, signal);
    } catch (error) {
      if (rawDeliveredSourceReply && rawSourceReplyFinal) {
        markTerminalSourceReplyDelivered(context.toolCall.id);
        params.onDeliveredSourceReply?.();
      } else if (isTerminalSourceReply) {
        releaseTerminalReservation(context.toolCall.id);
      }
      throw error;
    }
    const deliveredSourceReply = isDeliveredMessageToolOnlySourceReply({
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      context,
      hookResult,
    });
    if (deliveredSourceReply) {
      const sourceReplyFinal =
        readMessageToolSourceReplyFinal(context.result) ??
        readMessageToolSourceReplyFinal(hookResult) ??
        isTerminalSourceReply;
      if (sourceReplyFinal) {
        markTerminalSourceReplyDelivered(context.toolCall.id);
        params.onDeliveredSourceReply?.();
        return { ...hookResult, terminate: true };
      }
      if (isTerminalSourceReply) {
        releaseTerminalReservation(context.toolCall.id);
      }
      return hookResult;
    }
    if (isTerminalSourceReply) {
      releaseTerminalReservation(context.toolCall.id);
    }
    return hookResult;
  };
}
