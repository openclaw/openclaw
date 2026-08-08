import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
/**
 * Detects message-tool-only sends that delivered a visible source reply.
 */
import { isDeliveredMessageToolOnlySourceReplyResult } from "../../embedded-agent-message-tool-source-reply.js";
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  Agent,
  AgentTool,
  AgentToolResult,
} from "../../runtime/index.js";

const SOURCE_REPLY_ALREADY_DELIVERED_RESULT = {
  status: "suppressed",
  deliveryStatus: "suppressed",
  reason: "message_tool_only_source_reply_already_delivered",
  message: "A visible source reply was already delivered through the message tool for this run.",
} as const;
const SOURCE_REPLY_ALREADY_DELIVERED_REASON = SOURCE_REPLY_ALREADY_DELIVERED_RESULT.reason;

function createSuppressedDuplicateSourceReplyResult(): AgentToolResult<
  typeof SOURCE_REPLY_ALREADY_DELIVERED_RESULT
> {
  return {
    content: [{ type: "text", text: JSON.stringify(SOURCE_REPLY_ALREADY_DELIVERED_RESULT) }],
    details: SOURCE_REPLY_ALREADY_DELIVERED_RESULT,
    terminate: true,
  };
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

function isSuppressedDuplicateSourceReplyResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return false;
  }
  return (details as Record<string, unknown>).reason === SOURCE_REPLY_ALREADY_DELIVERED_REASON;
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

/** Installs message-tool-only guards and records source reply delivery evidence. */
export function installMessageToolOnlyTerminalHook(params: {
  agent: Agent;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  onDeliveredSourceReply?: () => void;
}): void {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  let deliveredSourceReply = false;
  let sourceReplySlotTaken = false;
  const wrapMessageTool = (tool: AgentTool): AgentTool => {
    if (tool.name !== "message") {
      return tool;
    }
    return {
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
        if (sourceReplySlotTaken) {
          return createSuppressedDuplicateSourceReplyResult();
        }
        sourceReplySlotTaken = true;
        try {
          const result = await tool.execute(toolCallId, args, signal, onUpdate);
          if (
            !isDeliveredMessageToolOnlySourceReplyResult({
              sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
              toolName: tool.name,
              args,
              result,
              isError: false,
            })
          ) {
            sourceReplySlotTaken = deliveredSourceReply;
          }
          return result;
        } catch (error) {
          sourceReplySlotTaken = deliveredSourceReply;
          throw error;
        }
      },
    };
  };
  if (params.agent.state.tools) {
    params.agent.state.tools = params.agent.state.tools.map(wrapMessageTool);
  }
  const previousResolveDeferredTool = params.agent.resolveDeferredTool?.bind(params.agent);
  if (previousResolveDeferredTool) {
    params.agent.resolveDeferredTool = async (context, signal) => {
      const tool = await previousResolveDeferredTool(context, signal);
      return tool ? wrapMessageTool(tool) : tool;
    };
  }
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    const deliveredMessageToolOnlySourceReply = isDeliveredMessageToolOnlySourceReply({
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      context,
      hookResult,
    });
    if (deliveredMessageToolOnlySourceReply) {
      deliveredSourceReply = true;
      sourceReplySlotTaken = true;
      params.onDeliveredSourceReply?.();
      return hookResult;
    }
    if (
      !deliveredSourceReply &&
      !isSuppressedDuplicateSourceReplyResult(context.result) &&
      isImplicitMessageToolOnlySourceReplySend({
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        toolName: context.toolCall.name,
        args: argsRecordForToolCall(context),
      })
    ) {
      sourceReplySlotTaken = false;
    }
    return hookResult;
  };
}
