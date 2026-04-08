import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { SAFETY_MARGIN, estimateMessagesTokens } from "../../compaction.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

/**
 * For large sessions (many messages or many tool results), token estimation
 * can undercount by 15-20% due to tokenizer overhead and tool result metadata.
 * Scale the safety margin beyond the base SAFETY_MARGIN for these sessions.
 */
const LARGE_SESSION_MESSAGE_THRESHOLD = 50;
const LARGE_SESSION_EXTRA_MARGIN = 1.15; // additional 15% on top of base SAFETY_MARGIN

export type PreemptiveCompactionRoute =
  | "fits"
  | "compact_only"
  | "truncate_tool_results_only"
  | "compact_then_truncate";

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const { messages, systemPrompt, prompt } = params;
  const syntheticMessages: AgentMessage[] = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
    syntheticMessages.push({
      role: "system",
      content: systemPrompt,
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  syntheticMessages.push({ role: "user", content: prompt, timestamp: 0 } as AgentMessage);

  const estimated =
    estimateMessagesTokens(messages) +
    syntheticMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  // Scale safety margin for large sessions where token estimation is less accurate.
  const margin =
    messages.length >= LARGE_SESSION_MESSAGE_THRESHOLD
      ? SAFETY_MARGIN * LARGE_SESSION_EXTRA_MARGIN
      : SAFETY_MARGIN;
  return Math.max(0, Math.ceil(estimated * margin));
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
}): {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
} {
  const estimatedPromptTokens = estimatePrePromptTokens(params);
  const promptBudgetBeforeReserve = Math.max(
    1,
    Math.floor(params.contextTokenBudget) - Math.max(0, Math.floor(params.reserveTokens)),
  );
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: params.messages,
    contextWindowTokens: params.contextTokenBudget,
  });
  const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (overflowTokens > 0) {
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  }
  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
  };
}
