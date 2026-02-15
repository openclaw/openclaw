import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";

const CHARS_PER_TOKEN_FALLBACK = 3.6;
const ESTIMATE_SAFETY_RATIO = 0.9;
const DEFAULT_DYNAMIC_RESERVE_RATIO = 0.08;
const MIN_DYNAMIC_RESERVE_TOKENS = 1200;

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : null;
}

function fallbackEstimateTokens(value: unknown): number {
  const text =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value) ?? "";
          } catch {
            return "";
          }
        })();
  if (!text) {
    return 1;
  }
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_FALLBACK));
}

export function estimateMessageTokens(message: AgentMessage): number {
  try {
    const estimate = estimateTokens(message);
    const normalized = normalizePositiveInt(estimate);
    if (normalized) {
      return normalized;
    }
  } catch {
    // Fall back to a conservative char-based estimate.
  }
  return fallbackEstimateTokens(message);
}

export function estimateTextTokens(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  try {
    const estimate = estimateTokens({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
    const normalized = normalizePositiveInt(estimate);
    if (normalized) {
      return normalized;
    }
  } catch {
    // Fall through to char-based estimate.
  }
  return fallbackEstimateTokens(text);
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function computeStaticPromptTokens(params: {
  systemPrompt: string;
  prompt: string;
}): number {
  return estimateTextTokens(params.systemPrompt) + estimateTextTokens(params.prompt);
}

export type ContextPlanResult = {
  messages: AgentMessage[];
  trimmed: boolean;
  reason: "empty" | "invalid-budget" | "under-budget" | "mandatory-tail-only" | "budget-trimmed";
  estimatedHistoryTokensBefore: number;
  estimatedHistoryTokensAfter: number;
  historyBudgetTokens: number;
  droppedMessages: number;
  droppedTokens: number;
};

export function planContextMessages(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  reserveTokens: number;
  staticPromptTokens: number;
  maxHistoryShare?: number;
  dynamicReserveRatio?: number;
  minDynamicReserveTokens?: number;
}): ContextPlanResult {
  const totalMessages = params.messages.length;
  if (totalMessages === 0) {
    return {
      messages: params.messages,
      trimmed: false,
      reason: "empty",
      estimatedHistoryTokensBefore: 0,
      estimatedHistoryTokensAfter: 0,
      historyBudgetTokens: 0,
      droppedMessages: 0,
      droppedTokens: 0,
    };
  }

  const tokenByIndex = params.messages.map((message) => estimateMessageTokens(message));
  const totalHistoryTokens = tokenByIndex.reduce((sum, tokens) => sum + tokens, 0);

  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const staticPromptTokens = Math.max(0, Math.floor(params.staticPromptTokens));
  const maxHistoryShare = clampFloat(params.maxHistoryShare ?? 1, 0.1, 1);
  const dynamicReserveRatio = clampFloat(
    params.dynamicReserveRatio ?? DEFAULT_DYNAMIC_RESERVE_RATIO,
    0,
    0.5,
  );
  const minDynamicReserveTokens = Math.max(
    0,
    Math.floor(params.minDynamicReserveTokens ?? MIN_DYNAMIC_RESERVE_TOKENS),
  );
  const dynamicReserveTokens = Math.max(
    minDynamicReserveTokens,
    Math.floor(contextWindowTokens * dynamicReserveRatio),
  );

  const availableForHistory =
    contextWindowTokens - reserveTokens - staticPromptTokens - dynamicReserveTokens;
  const historyBudgetTokens = Math.max(
    1,
    Math.floor(availableForHistory * ESTIMATE_SAFETY_RATIO * maxHistoryShare),
  );

  if (availableForHistory <= 0) {
    const fallbackTail = params.messages.slice(-1);
    const keptTokens = tokenByIndex[tokenByIndex.length - 1] ?? 0;
    return {
      messages: fallbackTail,
      trimmed: true,
      reason: "invalid-budget",
      estimatedHistoryTokensBefore: totalHistoryTokens,
      estimatedHistoryTokensAfter: keptTokens,
      historyBudgetTokens,
      droppedMessages: Math.max(0, totalMessages - fallbackTail.length),
      droppedTokens: Math.max(0, totalHistoryTokens - keptTokens),
    };
  }

  if (totalHistoryTokens <= historyBudgetTokens) {
    return {
      messages: params.messages,
      trimmed: false,
      reason: "under-budget",
      estimatedHistoryTokensBefore: totalHistoryTokens,
      estimatedHistoryTokensAfter: totalHistoryTokens,
      historyBudgetTokens,
      droppedMessages: 0,
      droppedTokens: 0,
    };
  }

  let mandatoryStart = totalMessages - 1;
  for (let i = totalMessages - 1; i >= 0; i -= 1) {
    if (params.messages[i]?.role === "user") {
      mandatoryStart = i;
      break;
    }
  }
  const mandatoryTailTokens = tokenByIndex
    .slice(mandatoryStart)
    .reduce((sum, tokens) => sum + tokens, 0);
  if (mandatoryTailTokens >= historyBudgetTokens) {
    const kept = params.messages.slice(mandatoryStart);
    return {
      messages: kept,
      trimmed: true,
      reason: "mandatory-tail-only",
      estimatedHistoryTokensBefore: totalHistoryTokens,
      estimatedHistoryTokensAfter: mandatoryTailTokens,
      historyBudgetTokens,
      droppedMessages: Math.max(0, totalMessages - kept.length),
      droppedTokens: Math.max(0, totalHistoryTokens - mandatoryTailTokens),
    };
  }

  let startIndex = mandatoryStart;
  let keptTokens = mandatoryTailTokens;
  for (let i = mandatoryStart - 1; i >= 0; i -= 1) {
    const nextTokens = tokenByIndex[i] ?? 0;
    if (keptTokens + nextTokens > historyBudgetTokens) {
      break;
    }
    keptTokens += nextTokens;
    startIndex = i;
  }

  const kept = params.messages.slice(startIndex);
  return {
    messages: kept,
    trimmed: startIndex > 0,
    reason: "budget-trimmed",
    estimatedHistoryTokensBefore: totalHistoryTokens,
    estimatedHistoryTokensAfter: keptTokens,
    historyBudgetTokens,
    droppedMessages: Math.max(0, startIndex),
    droppedTokens: Math.max(0, totalHistoryTokens - keptTokens),
  };
}
