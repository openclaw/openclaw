import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { readEmbeddedMessageDeliveryFact } from "../../embedded-agent-message-delivery.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  resolveMessageToolSourceReplyFinal,
} from "../../embedded-agent-message-tool-source-reply.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  extractToolAuthoredSourceReplyPayload,
  isDeliveredMessagingToolSendToCurrentSource,
} from "../../embedded-agent-messaging-extraction.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";
import {
  getInternalToolTurnCompletion,
  setInternalToolTurnCompletion,
} from "../../runtime/internal-hooks.js";
import { normalizeToolPolicyName } from "../../tool-policy-shared.js";
import { isToolResultError, readToolResultDetails } from "../../tool-result-error.js";

type MessageToolTerminalRoute = Omit<
  Parameters<typeof isDeliveredMessagingToolSendToCurrentSource>[0],
  "send" | "deliveredPayload"
> & {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

function argsRecordForToolCall(context: AfterToolCallContext): Record<string, unknown> {
  return asOptionalRecord(context.args) ?? asOptionalRecord(context.toolCall.arguments) ?? {};
}

/** Detects message-tool-only sends that delivered a visible current-source reply. */
function isDeliveredMessageToolOnlySourceReply(
  params: MessageToolTerminalRoute & {
    context: AfterToolCallContext;
    hookResult?: AfterToolCallResult;
  },
): boolean {
  const toolName = params.context.toolCall.name;
  const toolArgs = argsRecordForToolCall(params.context);
  const extractionArgs =
    toolName === "message" &&
    params.currentProvider &&
    typeof toolArgs.provider !== "string" &&
    typeof toolArgs.channel !== "string"
      ? { ...toolArgs, provider: params.currentProvider }
      : toolArgs;
  const pendingSend = extractMessagingToolSend(toolName, extractionArgs, params);
  const confirmedSend =
    pendingSend && extractMessagingToolSendResult(pendingSend, params.context.result);
  const deliveryFact = readEmbeddedMessageDeliveryFact(
    readToolResultDetails(params.context.result)?.messageDelivery,
  );
  const isError = params.hookResult?.isError ?? params.context.isError;
  return isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    toolName,
    args: toolArgs,
    result: params.hookResult ?? params.context.result,
    // Middleware may retain a delivery summary while redacting its source receipt.
    hookResult: params.context.result,
    isError,
    allowExplicitSourceRoute: isDeliveredMessagingToolSendToCurrentSource({
      ...params,
      send: confirmedSend,
      deliveredPayload: params.context.result,
    }),
    ...(deliveryFact
      ? {
          deliveryConfirmed:
            deliveryFact.status === "settled" && (!isError || deliveryFact.partialDelivery),
        }
      : {}),
  });
}

/**
 * Ends the turn after a tool batch settles in which a `canDeliverSourceReply` tool
 * authored a final source reply. The host delivers that reply itself, so another
 * model turn would only restate it. The decision runs once per assistant message,
 * after every call (capable or not, executed or rejected) has settled, so no sibling
 * outcome can reopen the turn. It admits exactly what the tool completion handler
 * captures: a direct, non-error result with a deliverable final reply.
 */
export function installToolAuthoredSourceReplyTerminalHook(params: {
  agent: Agent;
  sourceReplyCapableToolNames?: ReadonlySet<string>;
}): void {
  const capableToolNames = params.sourceReplyCapableToolNames;
  if (!capableToolNames?.size) {
    return;
  }
  const previous = getInternalToolTurnCompletion(params.agent);
  setInternalToolTurnCompletion(
    params.agent,
    (context) =>
      previous?.(context) === true ||
      context.toolResults.some(
        (toolResult) =>
          !toolResult.isError &&
          !isToolResultError(toolResult) &&
          capableToolNames.has(normalizeToolPolicyName(toolResult.toolName)) &&
          extractToolAuthoredSourceReplyPayload(toolResult) !== undefined,
      ),
  );
}

export function installMessageToolOnlyTerminalHook(
  params: MessageToolTerminalRoute & {
    agent: Agent;
    onDeliveredSourceReply?: () => void;
  },
): void {
  if (params.sourceReplyDeliveryMode !== "message_tool_only") {
    return;
  }
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    if (
      isDeliveredMessageToolOnlySourceReply({
        ...params,
        context,
        hookResult,
      })
    ) {
      params.onDeliveredSourceReply?.();
      if (resolveMessageToolSourceReplyFinal(argsRecordForToolCall(context))) {
        return { ...hookResult, terminate: true };
      }
    }
    return hookResult;
  };
}
