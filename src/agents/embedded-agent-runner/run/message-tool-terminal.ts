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
import { normalizeToolPolicyName } from "../../tool-policy-shared.js";
import { readToolResultDetails } from "../../tool-result-error.js";

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
 * Stops the tool batch after a `canDeliverSourceReply` tool authored a final source reply.
 * The host delivers that reply itself, so another model turn would only restate it.
 *
 * The agent loop ends a batch only when every result is terminal. Other calls from
 * the same assistant message still run to completion and are recorded; they carry
 * the terminal hint so the captured reply completes the turn. The capable call's own
 * result decides: if it captured no final reply, the batch continues as usual.
 */
export function installToolAuthoredSourceReplyTerminalHook(params: {
  agent: Agent;
  sourceReplyCapableToolNames?: ReadonlySet<string>;
}): void {
  const capableToolNames = params.sourceReplyCapableToolNames;
  if (!capableToolNames?.size) {
    return;
  }
  const isCapable = (name: string) => capableToolNames.has(normalizeToolPolicyName(name));
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    if (!isCapable(context.toolCall.name)) {
      const batchHasCapableCall = context.assistantMessage.content.some(
        (item) =>
          item.type === "toolCall" && item.id !== context.toolCall.id && isCapable(item.name),
      );
      return batchHasCapableCall
        ? { ...hookResult, terminate: hookResult?.terminate ?? context.result.terminate ?? true }
        : hookResult;
    }
    const isError = hookResult?.isError ?? context.isError;
    if (isError) {
      return hookResult;
    }
    // An earlier hook returns a partial override: only the fields it supplies
    // replace the executed result, exactly as the agent loop applies them.
    const result = hookResult
      ? {
          ...context.result,
          ...(hookResult.content !== undefined ? { content: hookResult.content } : {}),
          ...(hookResult.details !== undefined ? { details: hookResult.details } : {}),
        }
      : context.result;
    if (extractToolAuthoredSourceReplyPayload(result)) {
      return { ...hookResult, terminate: true };
    }
    return hookResult;
  };
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
