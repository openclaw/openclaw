import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { parseSessionThreadInfoFast } from "../../../config/sessions/thread-info.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
/**
 * Detects message-tool-only sends that delivered a visible source reply.
 */
import { isDeliveredMessageToolOnlySourceReplyResult } from "../../embedded-agent-message-tool-source-reply.js";
import { messagingToolSendResolvesToCurrentSource } from "../../embedded-agent-subscribe.tools.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";

function argsRecordForToolCall(context: AfterToolCallContext): Record<string, unknown> {
  if (context.args && typeof context.args === "object" && !Array.isArray(context.args)) {
    return context.args as Record<string, unknown>;
  }
  const fallbackArgs = context.toolCall.arguments;
  return fallbackArgs && typeof fallbackArgs === "object" && !Array.isArray(fallbackArgs)
    ? fallbackArgs
    : {};
}

type MessagingRouteContext = {
  config?: OpenClawConfig;
  messageChannel?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  sessionKey?: string;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

/**
 * Determines whether a `message.send` tool call delivered a visible source reply
 * in message-tool-only delivery mode. Only implicit-route, non-dry-run,
 * delivered sends qualify; explicit routes and errors are not source replies.
 */
function isDeliveredMessageToolOnlySourceReply(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  context: AfterToolCallContext;
  hookResult?: AfterToolCallResult;
  routeContext: MessagingRouteContext;
}): boolean {
  const toolName = params.context.toolCall.name;
  const args = argsRecordForToolCall(params.context);
  return isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    toolName,
    args,
    result: params.context.result,
    hookResult: params.hookResult,
    isError: params.hookResult?.isError ?? params.context.isError,
    // This hook runs in-process, but the gateway's trusted current-source
    // route tag is only applied when a signed message-action turn capability
    // accompanies the call, which this hook install site does not thread
    // through. Verify the route directly so an explicit-route reply to the
    // current source still counts as delivered and does not trip
    // stranded-reply recovery (openclaw-kg9, openclaw-p3j).
    allowExplicitSourceRoute: messagingToolSendResolvesToCurrentSource(
      toolName,
      args,
      params.routeContext.messageChannel,
      {
        config: params.routeContext.config,
        currentChannelId: params.routeContext.currentChannelId,
        currentMessagingTarget: params.routeContext.currentMessagingTarget,
        currentThreadId: parseSessionThreadInfoFast(params.routeContext.sessionKey).threadId,
        currentMessageId: params.routeContext.currentMessageId,
        replyToMode: params.routeContext.replyToMode,
        hasRepliedRef: params.routeContext.hasRepliedRef,
      },
    ),
  });
}

/** Installs an after-tool hook that records source reply delivery evidence. */
export function installMessageToolOnlyTerminalHook(
  params: {
    agent: Agent;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    onDeliveredSourceReply?: () => void;
  } & MessagingRouteContext,
): void {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    if (
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        context,
        hookResult,
        routeContext: params,
      })
    ) {
      params.onDeliveredSourceReply?.();
      return hookResult;
    }
    return hookResult;
  };
}
