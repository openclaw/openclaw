/**
 * Budget-exhaustion result builder and summary instruction.
 *
 * When an agent's iteration budget is exhausted, this module provides:
 * 1. A summary instruction injected into the prompt for a final grace call
 * 2. A result builder for the budget_exhausted error kind
 */

import type { EmbeddedAgentMeta, EmbeddedAgentRunMeta, EmbeddedAgentRunResult } from "../types.js";

/**
 * Instruction injected into the prompt when the iteration budget is exhausted
 * and forceSummaryOnExhaustion is enabled. This gives the LLM one final turn
 * to summarize work done so far without making further tool calls.
 */
export const BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION =
  "You have reached the maximum number of iterations for this run. " +
  "Please provide a concise summary of what you have accomplished so far, " +
  "any remaining work that was not completed, and any important findings. " +
  "Do NOT make any tool calls in this response.";

export function shouldReturnBudgetExhausted(params: {
  budgetExhausted: boolean;
  emptyAssistantReplyIsSilent: boolean;
  hasClientToolCalls: boolean;
  budgetSummaryAttempt: boolean;
  aborted: boolean;
  hasPromptError: boolean;
  timedOut: boolean;
  yieldDetected: boolean;
}): boolean {
  if (
    params.emptyAssistantReplyIsSilent ||
    params.hasClientToolCalls ||
    params.budgetSummaryAttempt ||
    params.aborted ||
    params.hasPromptError ||
    params.timedOut ||
    params.yieldDetected
  ) {
    return false;
  }

  return params.budgetExhausted;
}

/**
 * Build an EmbeddedAgentRunResult for a budget-exhausted run.
 */
export function buildBudgetExhaustedResult(params: {
  message: string;
  durationMs: number;
  agentMeta?: EmbeddedAgentMeta;
  aborted?: boolean;
  budgetUsed: number;
  budgetMax: number;
  summaryText?: string;
  systemPromptReport?: EmbeddedAgentRunMeta["systemPromptReport"];
  finalPromptText?: string;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  didSendViaMessagingTool?: EmbeddedAgentRunResult["didSendViaMessagingTool"];
  didDeliverSourceReplyViaMessageTool?: EmbeddedAgentRunResult["didDeliverSourceReplyViaMessageTool"];
  didSendDeterministicApprovalPrompt?: EmbeddedAgentRunResult["didSendDeterministicApprovalPrompt"];
  messagingToolSentTexts?: EmbeddedAgentRunResult["messagingToolSentTexts"];
  messagingToolSentMediaUrls?: EmbeddedAgentRunResult["messagingToolSentMediaUrls"];
  messagingToolSentTargets?: EmbeddedAgentRunResult["messagingToolSentTargets"];
  messagingToolSourceReplyPayloads?: EmbeddedAgentRunResult["messagingToolSourceReplyPayloads"];
  heartbeatToolResponse?: EmbeddedAgentRunResult["heartbeatToolResponse"];
  successfulCronAdds?: EmbeddedAgentRunResult["successfulCronAdds"];
  acceptedSessionSpawns?: EmbeddedAgentRunResult["acceptedSessionSpawns"];
}): EmbeddedAgentRunResult {
  const displayText =
    params.summaryText ??
    `Iteration budget exhausted (${params.budgetUsed}/${params.budgetMax}). ${params.message}`;

  return {
    payloads: [
      {
        text: displayText,
        isError: !params.summaryText,
      },
    ],
    meta: {
      durationMs: params.durationMs,
      agentMeta: params.agentMeta,
      aborted: params.aborted,
      systemPromptReport: params.systemPromptReport,
      finalPromptText: params.finalPromptText,
      finalAssistantVisibleText: params.finalAssistantVisibleText,
      finalAssistantRawText: params.finalAssistantRawText,
      replayInvalid: true,
      livenessState: "blocked",
      error: {
        kind: "budget_exhausted",
        message: `Iteration budget exhausted after ${params.budgetUsed} iterations (max: ${params.budgetMax}).`,
        fallbackSafe: false,
      },
    },
    didSendViaMessagingTool: params.didSendViaMessagingTool,
    didDeliverSourceReplyViaMessageTool: params.didDeliverSourceReplyViaMessageTool,
    didSendDeterministicApprovalPrompt: params.didSendDeterministicApprovalPrompt,
    messagingToolSentTexts: params.messagingToolSentTexts,
    messagingToolSentMediaUrls: params.messagingToolSentMediaUrls,
    messagingToolSentTargets: params.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: params.messagingToolSourceReplyPayloads,
    heartbeatToolResponse: params.heartbeatToolResponse,
    successfulCronAdds: params.successfulCronAdds,
    acceptedSessionSpawns: params.acceptedSessionSpawns,
  };
}
