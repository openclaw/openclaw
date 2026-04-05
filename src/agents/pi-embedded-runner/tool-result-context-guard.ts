import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";

// Keep a conservative input budget to absorb tokenizer variance and provider framing overhead.
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
// High-water mark: if context exceeds this ratio after tool-result compaction,
// trigger full session compaction via the existing overflow recovery cascade.
const PREEMPTIVE_OVERFLOW_RATIO = 0.9;

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
const CONTEXT_LIMIT_TRUNCATION_SUFFIX = `\n${CONTEXT_LIMIT_TRUNCATION_NOTICE}`;

export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";

export const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE =
  "Preemptive context overflow: estimated context size exceeds safe threshold during tool loop";

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  const bodyBudget = Math.max(0, maxChars - CONTEXT_LIMIT_TRUNCATION_SUFFIX.length);
  if (bodyBudget <= 0) {
    return CONTEXT_LIMIT_TRUNCATION_NOTICE;
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", bodyBudget);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  return text.slice(0, cutPoint) + CONTEXT_LIMIT_TRUNCATION_SUFFIX;
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }

  const rawText = getToolResultText(msg);
  if (!rawText) {
    return replaceToolResultText(msg, CONTEXT_LIMIT_TRUNCATION_NOTICE);
  }

  const truncatedText = truncateTextToBudget(rawText, maxChars);
  return replaceToolResultText(msg, truncatedText);
}

function findLastAssistantIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      return i;
    }
  }
  return -1;
}

function collectProtectedCurrentTurnToolResultIndexes(messages: AgentMessage[]): Set<number> {
  const lastAssistantIndex = findLastAssistantIndex(messages);
  if (lastAssistantIndex < 0) {
    return new Set<number>();
  }

  const protectedIndexes = new Set<number>();
  for (let i = lastAssistantIndex + 1; i < messages.length; i++) {
    if (isToolResultMessage(messages[i])) {
      protectedIndexes.add(i);
    }
  }
  return protectedIndexes;
}

function compactExistingToolResults(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
  protectedIndexes: ReadonlySet<number>;
}): AgentMessage[] {
  const { messages, charsNeeded, cache, protectedIndexes } = params;
  if (charsNeeded <= 0) {
    return messages;
  }

  let next: AgentMessage[] | null = null;
  let reduced = 0;
  // Compact newest-first among eligible older tool results so more of the cached prefix
  // survives without stripping the outputs from the active tool loop.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (protectedIndexes.has(i)) {
      continue;
    }
    const msg = (next ?? messages)[i];
    if (!isToolResultMessage(msg)) {
      continue;
    }

    const before = estimateMessageCharsCached(msg, cache);
    if (before <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
      continue;
    }

    const compacted = replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    const after = estimateMessageCharsCached(compacted, cache);
    if (after >= before) {
      continue;
    }

    if (!next) {
      next = messages.slice();
    }
    next[i] = compacted;
    reduced += before - after;
    if (reduced >= charsNeeded) {
      break;
    }
  }

  return next ?? messages;
}

function enforceToolResultContextBudget(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
}): AgentMessage[] {
  const { messages, contextBudgetChars, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();
  let next: AgentMessage[] | null = null;

  // Ensure each tool result has an upper bound before considering total context usage.
  for (let i = 0; i < messages.length; i++) {
    const message = (next ?? messages)[i];
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    if (truncated === message) {
      continue;
    }
    if (!next) {
      next = messages.slice();
    }
    next[i] = truncated;
  }

  const truncatedMessages = next ?? messages;
  let currentChars = estimateContextChars(truncatedMessages, estimateCache);
  if (currentChars <= contextBudgetChars) {
    return truncatedMessages;
  }

  const protectedIndexes = collectProtectedCurrentTurnToolResultIndexes(truncatedMessages);

  // Compact older tool outputs first so the active tool loop still sees the
  // fresh results it just asked for. If that's not enough, the 90% overflow
  // guard below will still trigger full session compaction.
  return compactExistingToolResults({
    messages: truncatedMessages,
    charsNeeded: currentChars - contextBudgetChars,
    cache: estimateCache,
    protectedIndexes,
  });
}

export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
}): () => void {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const contextBudgetChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * CONTEXT_INPUT_HEADROOM_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(
      contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );
  const preemptiveOverflowChars = Math.max(
    contextBudgetChars,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * PREEMPTIVE_OVERFLOW_RATIO),
  );

  // Agent.transformContext is private in pi-coding-agent, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const contextMessages = Array.isArray(transformed) ? transformed : messages;
    const guardedMessages = enforceToolResultContextBudget({
      messages: contextMessages,
      contextBudgetChars,
      maxSingleToolResultChars,
    });

    // After tool-result compaction, check if context still exceeds the high-water mark.
    // If it does, non-tool-result content dominates and only full LLM-based session
    // compaction can reduce context size. Throwing a context overflow error triggers
    // the existing overflow recovery cascade in run.ts.
    const postEnforcementChars = estimateContextChars(
      guardedMessages,
      createMessageCharEstimateCache(),
    );
    if (postEnforcementChars > preemptiveOverflowChars) {
      throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    }

    return guardedMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
