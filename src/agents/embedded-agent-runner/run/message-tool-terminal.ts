import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getAgentToolInputScope,
  resolveAgentAssistantTurnId,
} from "../../../../packages/agent-core/src/tool-execution-context.js";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  resolveMessageToolSourceReplyFinal,
} from "../../embedded-agent-message-tool-source-reply.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  isDeliveredMessagingToolSendToCurrentSource,
} from "../../embedded-agent-messaging-extraction.js";
import type { MessagingToolSourceReplyPayload } from "../../embedded-agent-messaging.types.js";
import { captureToolAuthoredSourceReply } from "../../embedded-agent-tool-authored-source-reply.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";
import {
  getInternalToolTurnCompletion,
  setInternalToolTurnCompletion,
} from "../../runtime/internal-hooks.js";
import { normalizeToolPolicyName } from "../../tool-policy-shared.js";
import { isToolResultError, readToolResultDetails } from "../../tool-result-error.js";
import { createSourceReplyBatchCompletion } from "../../tool-source-reply-completion.js";

type MessageToolTerminalRoute = Omit<
  Parameters<typeof isDeliveredMessagingToolSendToCurrentSource>[0],
  "send" | "deliveredPayload"
> & {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  messageToolFinalByDefault?: boolean;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
};

function argsRecordForToolCall(context: AfterToolCallContext): Record<string, unknown> {
  return asOptionalRecord(context.args) ?? asOptionalRecord(context.toolCall.arguments) ?? {};
}

/**
 * Admits a complete batch of direct tool-authored replies from the finalized
 * message results, after message_end extensions and persistence have settled.
 * Any failed or unhandled sibling leaves the entire batch with the model; no
 * partial reply is queued that could hide the continuation or its failure.
 */
export function installToolAuthoredSourceReplyTerminalHook(params: {
  agent: Agent;
  sourceReplyCapableToolNames?: ReadonlySet<string>;
  idempotencyScope: string;
  onSourceReplies: (payloads: MessagingToolSourceReplyPayload[]) => void;
}): () => void {
  const capableToolNames = params.sourceReplyCapableToolNames;
  if (!capableToolNames?.size) {
    return () => {};
  }
  const previous = getInternalToolTurnCompletion(params.agent);
  const complete: NonNullable<typeof previous> = (context) => {
    const previousComplete = previous?.(context) === true;
    const replies: MessagingToolSourceReplyPayload[] = [];
    for (const result of context.toolResults) {
      if (result.isError || isToolResultError(result)) {
        return previousComplete;
      }
      if (!capableToolNames.has(normalizeToolPolicyName(result.toolName))) {
        if (context.terminalToolCallIds.has(result.toolCallId)) {
          continue;
        }
        return previousComplete;
      }
      const reply = captureToolAuthoredSourceReply({
        result,
        toolCallId: result.toolCallId,
        idempotencyScope: resolveAgentAssistantTurnId(context.message) ?? params.idempotencyScope,
      });
      if (!reply) {
        const sourceReply = asOptionalRecord(readToolResultDetails(result)?.sourceReply);
        if (sourceReply?.final !== false && context.terminalToolCallIds.has(result.toolCallId)) {
          continue;
        }
        return previousComplete;
      }
      replies.push({
        ...reply,
        toolAuthoredForTurnId: resolveAgentAssistantTurnId(context.message),
      });
    }
    if (replies.length === 0) {
      return previousComplete;
    }
    params.onSourceReplies(replies);
    return true;
  };
  setInternalToolTurnCompletion(params.agent, complete);
  return () => {
    if (getInternalToolTurnCompletion(params.agent) === complete) {
      setInternalToolTurnCompletion(params.agent, previous);
    }
  };
}

export function installMessageToolTerminalHook(
  params: MessageToolTerminalRoute & {
    agent: Agent;
    onDeliveredSourceReply?: () => void;
  },
): void {
  const finalReplyInputs = new Set<object>();
  const nestedCompletion = createSourceReplyBatchCompletion();
  const previousCompletion = getInternalToolTurnCompletion(params.agent);
  // Let sibling tools settle, then finish without another model request.
  setInternalToolTurnCompletion(params.agent, (context) => {
    const completed = nestedCompletion.complete(
      context.toolResults,
      finalReplyInputs.has(context.inputScope),
      context.inputScope,
    );
    finalReplyInputs.clear();
    return previousCompletion?.(context) === true || completed;
  });
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const inputScope = getAgentToolInputScope(context);
    // Capture private cell identity before presentation can replace or reject its result.
    nestedCompletion.observe(context.result);
    const toolName = context.toolCall.name;
    const toolArgs = argsRecordForToolCall(context);
    const final = resolveMessageToolSourceReplyFinal(toolArgs, params.messageToolFinalByDefault);
    const extractionArgs =
      toolName === "message" &&
      params.currentProvider &&
      typeof toolArgs.provider !== "string" &&
      typeof toolArgs.channel !== "string"
        ? { ...toolArgs, provider: params.currentProvider }
        : toolArgs;
    const pendingSend = extractMessagingToolSend(toolName, extractionArgs, params);
    const confirmedSend =
      pendingSend && extractMessagingToolSendResult(pendingSend, context.result);
    const isDelivered = (hookResult?: AfterToolCallResult) =>
      isDeliveredMessageToolOnlySourceReplyResult({
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        toolName,
        args: toolArgs,
        result: hookResult ?? context.result,
        // Middleware may retain a delivery summary while redacting its source receipt.
        hookResult: context.result,
        isError: hookResult?.isError ?? context.isError,
        allowExplicitSourceRoute: isDeliveredMessagingToolSendToCurrentSource({
          ...params,
          send: confirmedSend,
          deliveredPayload: context.result,
        }),
      });
    // Presentation hooks cannot revoke delivery or finality already committed by the tool.
    let delivered = isDelivered();
    let hookResult: AfterToolCallResult | undefined;
    try {
      hookResult = await previousAfterToolCall?.(context, signal);
    } finally {
      delivered ||= isDelivered(hookResult);
      if (delivered) {
        if (final && inputScope) {
          finalReplyInputs.add(inputScope);
        }
        params.onDeliveredSourceReply?.();
      }
    }
    return delivered && final ? { ...hookResult, terminate: true } : hookResult;
  };
}
