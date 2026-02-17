import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { calculateMaxToolResultChars } from "./tool-result-truncation.js";

const CHARS_PER_TOKEN_ESTIMATE = 4;
// Keep a conservative input budget to absorb tokenizer variance and provider framing overhead.
const CONTEXT_INPUT_HEADROOM_RATIO = 0.85;
const IMAGE_CHAR_ESTIMATE = 8_000;

export const CONTEXT_LIMIT_TRUNCATION_NOTICE = "[truncated: output exceeded context limit]";
const CONTEXT_LIMIT_TRUNCATION_SUFFIX = `\n\n${CONTEXT_LIMIT_TRUNCATION_NOTICE}`;

export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[old tool result compacted to keep context within limit]";

type ToolResultLike = Extract<AgentMessage, { role: "toolResult" }>;

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = {
  transformContext?: GuardableTransformContext;
};

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "text";
}

function isImageBlock(block: unknown): boolean {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "image";
}

function getToolResultContent(msg: AgentMessage): unknown[] {
  if ((msg as { role?: unknown }).role !== "toolResult") {
    return [];
  }
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function getToolResultText(msg: AgentMessage): string {
  const content = getToolResultContent(msg);
  const chunks: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n");
}

function toolResultHasImages(msg: AgentMessage): boolean {
  const content = getToolResultContent(msg);
  for (const block of content) {
    if (isImageBlock(block)) {
      return true;
    }
  }
  return false;
}

function estimateMessageChars(msg: AgentMessage): number {
  if (!msg || typeof msg !== "object") {
    return 0;
  }

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      return content.length;
    }
    let chars = 0;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isTextBlock(block)) {
          chars += block.text.length;
        } else if (isImageBlock(block)) {
          chars += IMAGE_CHAR_ESTIMATE;
        }
      }
    }
    return chars;
  }

  if (msg.role === "assistant") {
    let chars = 0;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const typed = block as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          arguments?: unknown;
        };
        if (typed.type === "text" && typeof typed.text === "string") {
          chars += typed.text.length;
        } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
          chars += typed.thinking.length;
        } else if (typed.type === "toolCall") {
          try {
            chars += JSON.stringify(typed.arguments ?? {}).length;
          } catch {
            chars += 128;
          }
        }
      }
    }
    return chars;
  }

  if (msg.role === "toolResult") {
    let chars = 0;
    const content = getToolResultContent(msg);
    for (const block of content) {
      if (isTextBlock(block)) {
        chars += block.text.length;
      } else if (isImageBlock(block)) {
        chars += IMAGE_CHAR_ESTIMATE;
      }
    }
    return chars;
  }

  return 256;
}

function estimateContextChars(messages: AgentMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageChars(msg), 0);
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

function truncateToolResultToChars(msg: AgentMessage, maxChars: number): AgentMessage {
  if ((msg as { role?: unknown }).role !== "toolResult") {
    return msg;
  }

  if (toolResultHasImages(msg)) {
    return msg;
  }

  const rawText = getToolResultText(msg);
  if (!rawText) {
    return msg;
  }

  if (rawText.length <= maxChars) {
    return msg;
  }

  const truncatedText = truncateTextToBudget(rawText, maxChars);
  return {
    ...(msg as unknown as Record<string, unknown>),
    content: [{ type: "text", text: truncatedText }],
  } as AgentMessage;
}

function compactExistingToolResultsInPlace(params: {
  messages: AgentMessage[];
  charsNeeded: number;
  skipMessageIndex?: number;
}): number {
  const { messages, charsNeeded, skipMessageIndex } = params;
  if (charsNeeded <= 0) {
    return 0;
  }

  let reduced = 0;
  for (let i = 0; i < messages.length; i++) {
    if (skipMessageIndex !== undefined && i === skipMessageIndex) {
      continue;
    }

    const msg = messages[i];
    if ((msg as { role?: unknown }).role !== "toolResult") {
      continue;
    }
    if (toolResultHasImages(msg)) {
      continue;
    }

    const text = getToolResultText(msg);
    if (!text) {
      continue;
    }

    const before = text.length;
    const after = PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER.length;
    if (before <= after) {
      continue;
    }

    (msg as unknown as ToolResultLike).content = [
      { type: "text", text: PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER },
    ];

    reduced += before - after;
    if (reduced >= charsNeeded) {
      break;
    }
  }

  return reduced;
}

function applyMessageMutationInPlace(target: AgentMessage, source: AgentMessage): void {
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
}

function findNewestCompactableToolResultIndex(messages: AgentMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if ((message as { role?: unknown }).role !== "toolResult") {
      continue;
    }
    if (toolResultHasImages(message)) {
      continue;
    }
    const text = getToolResultText(message);
    if (!text) {
      continue;
    }
    return i;
  }

  return undefined;
}

function enforceToolResultContextBudgetInPlace(params: {
  messages: AgentMessage[];
  contextBudgetChars: number;
  maxSingleToolResultChars: number;
}): void {
  const { messages, contextBudgetChars, maxSingleToolResultChars } = params;

  // Ensure each tool result has an upper bound before considering total context usage.
  for (const message of messages) {
    if ((message as { role?: unknown }).role !== "toolResult") {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars);
    applyMessageMutationInPlace(message, truncated);
  }

  let currentChars = estimateContextChars(messages);
  if (currentChars <= contextBudgetChars) {
    return;
  }

  // Prefer compacting older tool outputs first and preserve the newest one for targeted truncation.
  const newestToolResultIndex = findNewestCompactableToolResultIndex(messages);
  compactExistingToolResultsInPlace({
    messages,
    charsNeeded: currentChars - contextBudgetChars,
    skipMessageIndex: newestToolResultIndex,
  });

  currentChars = estimateContextChars(messages);
  if (currentChars <= contextBudgetChars) {
    return;
  }

  // If overflow remains, trim the newest text-only tool result to the remaining budget.
  if (newestToolResultIndex !== undefined) {
    const candidate = messages[newestToolResultIndex];
    const candidateChars = estimateMessageChars(candidate);
    const nonCandidateChars = currentChars - candidateChars;
    const availableForCandidate = Math.max(0, contextBudgetChars - nonCandidateChars);
    const truncated = truncateToolResultToChars(candidate, availableForCandidate);
    applyMessageMutationInPlace(candidate, truncated);
  }

  currentChars = estimateContextChars(messages);
  if (currentChars > contextBudgetChars) {
    compactExistingToolResultsInPlace({
      messages,
      charsNeeded: currentChars - contextBudgetChars,
    });
  }
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
  const maxSingleToolResultChars = Math.min(
    calculateMaxToolResultChars(contextWindowTokens),
    contextBudgetChars,
  );

  const originalTransformContext = params.agent.transformContext;

  params.agent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(params.agent, messages, signal)
      : messages;

    const contextMessages = Array.isArray(transformed) ? transformed : messages;
    enforceToolResultContextBudgetInPlace({
      messages: contextMessages,
      contextBudgetChars,
      maxSingleToolResultChars,
    });

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    params.agent.transformContext = originalTransformContext;
  };
}
