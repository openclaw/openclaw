/** Effect-free replay transforms shared by the host and transcript preparation worker. */
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../runtime/index.js";
import { isThinkingLikeBlock } from "../thinking-block.js";
import { isAssistantMessageWithContent } from "../thinking-signatures.js";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];

const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function isToolCallBlock(block: AssistantContentBlock): boolean {
  const type = asOptionalObjectRecord(block)?.type;
  return type === "toolCall" || type === "tool_use" || type === "function_call";
}

export type ThinkingReplayAdapter<T, B> = {
  role(message: T): string | undefined;
  content(message: T): readonly B[] | undefined;
  thinking(block: B): boolean;
  signature(block: B): boolean;
  toolCall(block: B): boolean;
  replace(message: T, content: B[], placeholder: string): T;
};

export function transformThinkingReplay<T, B>(
  messages: T[],
  adapter: ThinkingReplayAdapter<T, B>,
  operation: "invalid-signatures" | "drop-thinking" | "drop-reasoning" | "strip-all",
  preserveLatestAssistant = true,
): T[] {
  const isAssistant = (message: T) =>
    adapter.role(message) === "assistant" && adapter.content(message) !== undefined;
  const latestAssistant = messages.findLastIndex(isAssistant);
  let preserved =
    operation === "drop-thinking" || (operation === "invalid-signatures" && preserveLatestAssistant)
      ? latestAssistant
      : -1;
  if (operation === "drop-reasoning") {
    preserved = findCurrentThinkingToolTurn(messages, adapter);
  }
  let touched = false;
  const result = messages.map((message, index) => {
    if (!isAssistant(message) || index === preserved) {
      return message;
    }
    const content = adapter.content(message)!;
    const filtered = content.filter(
      (block) =>
        !adapter.thinking(block) ||
        (operation === "invalid-signatures" && adapter.signature(block)),
    );
    const next =
      filtered.length === content.length
        ? message
        : adapter.replace(message, filtered, OMITTED_ASSISTANT_REASONING_TEXT);
    touched ||= next !== message;
    return next;
  });
  return touched ? result : messages;
}

export function findCurrentThinkingToolTurn<T, B>(
  messages: readonly T[],
  adapter: ThinkingReplayAdapter<T, B>,
): number {
  const latestUser = messages.findLastIndex((message) => adapter.role(message) === "user");
  const index = messages.findIndex(
    (message, candidate) => candidate > latestUser && adapter.role(message) === "assistant",
  );
  const message = messages[index];
  return message &&
    adapter.content(message)?.some((block) => adapter.toolCall(block)) &&
    messages.some((next, candidate) => candidate > index && adapter.role(next) === "toolResult")
    ? index
    : -1;
}

const thinkingArrayAdapter: ThinkingReplayAdapter<AgentMessage, AssistantContentBlock> = {
  role: (message) => message?.role,
  content: (message) => (isAssistantMessageWithContent(message) ? message.content : undefined),
  thinking: isThinkingLikeBlock,
  signature: hasReplayableThinkingSignature,
  toolCall: isToolCallBlock,
  replace: (message, content, placeholder) =>
    message.role === "assistant"
      ? {
          ...message,
          content: content.length > 0 ? content : [{ type: "text", text: placeholder }],
        }
      : message,
};

export function hasReplayableThinkingSignature(block: AssistantContentBlock): boolean {
  const record = asOptionalObjectRecord(block);
  if (!record) {
    return false;
  }
  const candidates =
    record.type === "redacted_thinking"
      ? [record.data, record.signature, record.thinkingSignature, record.thought_signature]
      : [record.signature, record.thinkingSignature, record.thought_signature];
  return candidates.some(
    (signature) => typeof signature === "string" && signature.trim().length > 0,
  );
}

/**
 * Providers decide opaque signature validity; only missing or blank signatures are stripped.
 * Preserve the latest assistant turn for provider recovery unless the caller appends a user turn.
 */
export function stripInvalidThinkingSignatures(
  messages: AgentMessage[],
  options: { preserveLatestAssistant?: boolean } = {},
): AgentMessage[] {
  return transformThinkingReplay(
    messages,
    thinkingArrayAdapter,
    "invalid-signatures",
    options.preserveLatestAssistant ?? true,
  );
}

/** Keep the latest assistant thinking; historical empty turns receive an omission marker. */
export function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  return transformThinkingReplay(messages, thinkingArrayAdapter, "drop-thinking");
}

export function shouldPreserveLatestAssistantThinking(messages: AgentMessage[]): boolean {
  const latest = messages.findLastIndex(isAssistantMessageWithContent);
  return (
    latest >= 0 &&
    (latest === messages.length - 1 ||
      latest === findCurrentThinkingToolTurn(messages, thinkingArrayAdapter))
  );
}

export function stripThinkingBlocksFromMessage(message: AgentMessage): AgentMessage {
  return transformThinkingReplay([message], thinkingArrayAdapter, "strip-all")[0]!;
}

export function stripAllThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  return transformThinkingReplay(messages, thinkingArrayAdapter, "strip-all");
}

export function dropReasoningFromHistory(messages: AgentMessage[]): AgentMessage[] {
  return transformThinkingReplay(messages, thinkingArrayAdapter, "drop-reasoning");
}
