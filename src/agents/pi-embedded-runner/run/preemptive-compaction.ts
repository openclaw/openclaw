import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { SAFETY_MARGIN, estimateMessagesTokens } from "../../compaction.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const { messages, systemPrompt, prompt } = params;
  const syntheticMessages: AgentMessage[] = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
    syntheticMessages.push({ role: "system", content: systemPrompt } as AgentMessage);
  }
  syntheticMessages.push({ role: "user", content: prompt } as AgentMessage);

  const estimated =
    estimateMessagesTokens(messages) +
    syntheticMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return Math.max(0, Math.ceil(estimated * SAFETY_MARGIN));
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
}): {
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
} {
  const estimatedPromptTokens = estimatePrePromptTokens(params);
  const promptBudgetBeforeReserve = Math.max(
    1,
    Math.floor(params.contextTokenBudget) - Math.max(0, Math.floor(params.reserveTokens)),
  );
  return {
    shouldCompact: estimatedPromptTokens > promptBudgetBeforeReserve,
    estimatedPromptTokens,
    promptBudgetBeforeReserve,
  };
}
