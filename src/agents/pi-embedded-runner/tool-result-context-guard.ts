import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";
import { truncateToolResultText } from "./tool-result-truncation.js";

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
export const PREEMPTIVE_TOOL_RESULT_COMPACTION_NOTICE =
  "[compacted: tool output trimmed to free context]";

export const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE =
  "Preemptive context overflow: estimated context size exceeds safe threshold during tool loop";

const PREEMPTIVE_TOOL_RESULT_COMPACTION_SUFFIX = `\n${PREEMPTIVE_TOOL_RESULT_COMPACTION_NOTICE}`;
const MIN_COMPACTED_TOOL_RESULT_TEXT_CHARS = 96;
const TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO =
  CHARS_PER_TOKEN_ESTIMATE / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;
const MIN_COMPACTED_TOOL_RESULT_ESTIMATE_CHARS = Math.ceil(
  MIN_COMPACTED_TOOL_RESULT_TEXT_CHARS * TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO,
);

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

function getToolResultName(msg: AgentMessage): string | undefined {
  const toolName = (msg as { toolName?: unknown }).toolName;
  if (typeof toolName === "string" && toolName.trim().length > 0) {
    return toolName;
  }
  const legacyToolName = (msg as { tool_name?: unknown }).tool_name;
  return typeof legacyToolName === "string" && legacyToolName.trim().length > 0
    ? legacyToolName
    : undefined;
}

function isReadToolResultMessage(msg: AgentMessage): boolean {
  return isToolResultMessage(msg) && getToolResultName(msg) === "read";
}

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

function estimateBudgetToTextBudget(maxChars: number): number {
  return Math.max(0, Math.floor(maxChars / TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO));
}

function compactToolResultToEstimateBudget(
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
    return replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  }

  const textBudget = estimateBudgetToTextBudget(maxChars);
  if (textBudget <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
    return replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  }

  const maxCompactedTextChars = Math.max(MIN_COMPACTED_TOOL_RESULT_TEXT_CHARS, textBudget);
  if (maxCompactedTextChars <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
    return replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
  }

  const minKeepChars = Math.max(
    96,
    Math.min(
      MIN_COMPACTED_TOOL_RESULT_TEXT_CHARS,
      maxCompactedTextChars - PREEMPTIVE_TOOL_RESULT_COMPACTION_SUFFIX.length - 1,
    ),
  );

  const compactedText = truncateToolResultText(rawText, maxCompactedTextChars, {
    suffix: PREEMPTIVE_TOOL_RESULT_COMPACTION_SUFFIX,
    minKeepChars,
  });

  return replaceToolResultText(msg, compactedText);
}

function compactToPlaceholderInPlace(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
}): number {
  const { messages, charsNeeded, cache } = params;
  if (charsNeeded <= 0) {
    return 0;
  }

  let reduced = 0;
  for (const i of resolveToolResultCompactionOrder(messages)) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) {
      continue;
    }

    const before = estimateMessageCharsCached(msg, cache);
    if (before <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
      continue;
    }

    const compacted = replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
    applyMessageMutationInPlace(msg, compacted, cache);
    const after = estimateMessageCharsCached(msg, cache);
    if (after >= before) {
      continue;
    }

    reduced += before - after;
    if (reduced >= charsNeeded) {
      break;
    }
  }

  return reduced;
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

  const textBudget = estimateBudgetToTextBudget(maxChars);
  if (textBudget <= 0) {
    return replaceToolResultText(msg, CONTEXT_LIMIT_TRUNCATION_NOTICE);
  }

  if (rawText.length <= textBudget) {
    return replaceToolResultText(msg, rawText);
  }

  const truncatedText = truncateTextToBudget(rawText, textBudget);
  return replaceToolResultText(msg, truncatedText);
}

function compactExistingToolResultsInPlace(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  cache: MessageCharEstimateCache;
}): number {
  const { messages, charsNeeded, cache } = params;
  if (charsNeeded <= 0) {
    return 0;
  }

  let reduced = 0;
  // Keep the most recent tool result visible as long as older tool outputs can
  // absorb the overflow. Among older tool results, compact newest-first so we
  // still preserve as much of the cached prefix as possible.
  for (const i of resolveToolResultCompactionOrder(messages)) {
    const msg = messages[i];
    if (!isToolResultMessage(msg)) {
      continue;
    }

    const before = estimateMessageCharsCached(msg, cache);
    if (before <= PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length) {
      continue;
    }

    const targetAfter = Math.max(
      MIN_COMPACTED_TOOL_RESULT_ESTIMATE_CHARS,
      before - (charsNeeded - reduced),
    );

    let compacted = compactToolResultToEstimateBudget(msg, targetAfter, cache);
    let after = estimateMessageCharsCached(compacted, cache);
    if (after >= before) {
      compacted = replaceToolResultText(msg, PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER);
      after = estimateMessageCharsCached(compacted, cache);
    }

    applyMessageMutationInPlace(msg, compacted, cache);
    if (after >= before) {
      continue;
    }

    reduced += before - after;
    if (reduced >= charsNeeded) {
      break;
    }
  }

  if (reduced < charsNeeded) {
    reduced += compactToPlaceholderInPlace({
      messages,
      charsNeeded: charsNeeded - reduced,
      cache,
    });
  }

  return reduced;
}

function resolveToolResultCompactionOrder(messages: AgentMessage[]): number[] {
  const toolResultIndexes: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (isToolResultMessage(messages[i])) {
      toolResultIndexes.push(i);
    }
  }
  if (toolResultIndexes.length <= 1) {
    return toolResultIndexes;
  }
  const newestIndex = toolResultIndexes[toolResultIndexes.length - 1];
  const olderIndexes = toolResultIndexes.slice(0, -1).toReversed();
  return [...olderIndexes, newestIndex];
}

function getNewestToolResultIndex(messages: AgentMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isToolResultMessage(messages[i])) {
      return i;
    }
  }
  return undefined;
}

function shouldPreferOverflowForLatestRead(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
}): boolean {
  const newestToolResultIndex = getNewestToolResultIndex(params.messages);
  if (newestToolResultIndex === undefined) {
    return false;
  }
  const newestToolResult = params.messages[newestToolResultIndex];
  if (!isReadToolResultMessage(newestToolResult)) {
    return false;
  }

  const initialCache = createMessageCharEstimateCache();
  if (
    estimateMessageCharsCached(newestToolResult, initialCache) > params.maxSingleToolResultChars
  ) {
    return false;
  }

  const simulatedMessages = cloneMessagesForGuard(params.messages);
  const estimateCache = createMessageCharEstimateCache();
  for (const message of simulatedMessages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(
      message,
      params.maxSingleToolResultChars,
      estimateCache,
    );
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }

  const currentChars = estimateContextChars(simulatedMessages, estimateCache);
  if (currentChars <= params.contextBudgetChars) {
    return false;
  }

  const newestToolResultAfterPerToolLimit = simulatedMessages[newestToolResultIndex];
  const newestToolResultTextBefore = getToolResultText(newestToolResultAfterPerToolLimit);
  compactExistingToolResultsInPlace({
    messages: simulatedMessages,
    charsNeeded: currentChars - params.contextBudgetChars,
    cache: estimateCache,
  });
  return getToolResultText(simulatedMessages[newestToolResultIndex]) !== newestToolResultTextBefore;
}

function cloneMessagesForGuard(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(
    (msg) => ({ ...(msg as unknown as Record<string, unknown>) }) as unknown as AgentMessage,
  );
}

function contextNeedsToolResultCompaction(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
}): boolean {
  const { messages, contextBudgetChars, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();
  let sawToolResult = false;
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    sawToolResult = true;
    if (estimateMessageCharsCached(message, estimateCache) > maxSingleToolResultChars) {
      return true;
    }
  }
  return sawToolResult && estimateContextChars(messages, estimateCache) > contextBudgetChars;
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) {
    return;
  }

  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function enforceToolResultContextBudgetInPlace(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
}): void {
  const { messages, contextBudgetChars, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();

  // Ensure each tool result has an upper bound before considering total context usage.
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }

  let currentChars = estimateContextChars(messages, estimateCache);
  if (currentChars <= contextBudgetChars) {
    return;
  }

  // Prefer compacting older tool outputs before sacrificing the newest one;
  // stop once the context is back under budget.
  compactExistingToolResultsInPlace({
    messages,
    charsNeeded: currentChars - contextBudgetChars,
    cache: estimateCache,
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

    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    if (
      shouldPreferOverflowForLatestRead({
        messages: sourceMessages,
        contextBudgetChars,
        maxSingleToolResultChars,
      })
    ) {
      throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    }
    const contextMessages = contextNeedsToolResultCompaction({
      messages: sourceMessages,
      contextBudgetChars,
      maxSingleToolResultChars,
    })
      ? cloneMessagesForGuard(sourceMessages)
      : sourceMessages;
    enforceToolResultContextBudgetInPlace({
      messages: contextMessages,
      contextBudgetChars,
      maxSingleToolResultChars,
    });

    // After tool-result compaction, check if context still exceeds the high-water mark.
    // If it does, non-tool-result content dominates and only full LLM-based session
    // compaction can reduce context size. Throwing a context overflow error triggers
    // the existing overflow recovery cascade in run.ts.
    const postEnforcementChars = estimateContextChars(
      contextMessages,
      createMessageCharEstimateCache(),
    );
    if (postEnforcementChars > preemptiveOverflowChars) {
      throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    }

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
