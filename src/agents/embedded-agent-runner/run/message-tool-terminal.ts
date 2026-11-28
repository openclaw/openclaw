import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getInternalToolTurnCompletion,
  setInternalToolTurnCompletion,
} from "../../../../packages/agent-core/src/internal-hooks.js";
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
import { normalizeToolPolicyName } from "../../tool-policy-shared.js";
import { isToolResultError, readToolResultDetails } from "../../tool-result-error.js";
import { createSourceReplyBatchCompletion } from "../../tool-source-reply-completion.js";
import { isResumingAlreadyPendingSessionsYieldResult } from "../../tools/sessions-yield-tool.js";

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
  // Per input: a steered or queued input must deliver its own reply before its yield ends it.
  const deliveredReplyInputs = new WeakSet<object>();
  // Inputs that ran a tool and have no final reply yet. A final reply completes its own
  // input first, else the oldest open one; the run ends on it only when none stay open.
  const openInputs = new Set<object>();
  const answeredInputs = new WeakSet<object>();
  const completeInput = (input: object): boolean => {
    const answered = openInputs.has(input) ? input : openInputs.values().next().value;
    if (answered) {
      openInputs.delete(answered);
      answeredInputs.add(answered);
    }
    return openInputs.size === 0;
  };
  const nestedCompletion = createSourceReplyBatchCompletion();
  const previousCompletion = getInternalToolTurnCompletion(params.agent);
  // Let sibling tools settle, then finish without another model request.
  setInternalToolTurnCompletion(params.agent, (context) => {
    const directFinal = finalReplyInputs.has(context.inputScope);
    const completed = nestedCompletion.complete(
      context.toolResults,
      directFinal,
      context.inputScope,
    );
    finalReplyInputs.clear();
    // A nested final send ends the run under the same open-input rule as a direct one.
    return (
      previousCompletion?.(context) === true ||
      (completed && (directFinal || completeInput(context.inputScope)))
    );
  });
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const inputScope = getAgentToolInputScope(context);
    if (inputScope && !answeredInputs.has(inputScope)) {
      openInputs.add(inputScope);
    }
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
    let endsRun = false;
    try {
      hookResult = await previousAfterToolCall?.(context, signal);
    } finally {
      delivered ||= isDelivered(hookResult);
      if (delivered) {
        if (inputScope) {
          deliveredReplyInputs.add(inputScope);
        }
        endsRun = final && (!inputScope || completeInput(inputScope));
        if (endsRun && inputScope) {
          finalReplyInputs.add(inputScope);
        }
        params.onDeliveredSourceReply?.();
      }
    }
    // The visible reply already went out and an earlier turn's wake resumes this session.
    const endsAfterPendingYield =
      inputScope !== undefined &&
      deliveredReplyInputs.has(inputScope) &&
      !context.isError &&
      isResumingAlreadyPendingSessionsYieldResult(toolName, context.result);
    if (endsAfterPendingYield) {
      finalReplyInputs.add(inputScope);
    }
    return endsRun || endsAfterPendingYield ? { ...hookResult, terminate: true } : hookResult;
  };
}
