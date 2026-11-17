/** Effect-free replay transforms shared by the host and transcript preparation worker. */
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "../runtime/index.js";
import { isThinkingLikeBlock } from "../thinking-block.js";
import { isAssistantMessageWithContent } from "../thinking-signatures.js";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

const OMITTED_ASSISTANT_REASONING_TEXT = "[assistant reasoning omitted]";

function isToolCallBlock(block: AssistantContentBlock): boolean {
  const type = asOptionalObjectRecord(block)?.type;
  return type === "toolCall" || type === "tool_use" || type === "function_call";
}

function mapAssistantMessages(
  messages: AgentMessage[],
  transform: (message: AssistantMessage, index: number) => AgentMessage,
): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const next = isAssistantMessageWithContent(message) ? transform(message, index) : message;
    touched ||= next !== message;
    out.push(next);
  }
  return touched ? out : messages;
}

function filterAssistantContent(
  message: AssistantMessage,
  keepBlock: (block: AssistantContentBlock) => boolean,
): AssistantMessage {
  const content = message.content.filter(keepBlock);
  return content.length === message.content.length
    ? message
    : {
        ...message,
        // Provider converters drop blank blocks; preserve the assistant turn with nonempty text.
        content:
          content.length > 0 ? content : [{ type: "text", text: OMITTED_ASSISTANT_REASONING_TEXT }],
      };
}

function hasReplayableThinkingSignature(block: AssistantContentBlock): boolean {
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
  const latestAssistantIndex =
    (options.preserveLatestAssistant ?? true)
      ? messages.findLastIndex(isAssistantMessageWithContent)
      : -1;
  return mapAssistantMessages(messages, (message, index) =>
    index === latestAssistantIndex
      ? message
      : filterAssistantContent(
          message,
          (block) => !isThinkingLikeBlock(block) || hasReplayableThinkingSignature(block),
        ),
  );
}

/**
 * Keep the latest turn's replay signatures and preserve empty turns with placeholder text.
 * Unchanged history retains its original array identity.
 */
export function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  const latestAssistantIndex = messages.findLastIndex(isAssistantMessageWithContent);
  return mapAssistantMessages(messages, (message, index) =>
    index === latestAssistantIndex ? message : stripThinkingBlocksFromMessage(message),
  );
}

function findCurrentToolTurnAssistantIndex(messages: AgentMessage[]): number {
  const latestUserIndex = messages.findLastIndex((message) => message?.role === "user");
  // Even an assistant without content ends the first-assistant eligibility window.
  const index = messages.findIndex(
    (message, candidateIndex) => candidateIndex > latestUserIndex && message?.role === "assistant",
  );
  const message = messages[index];
  return message &&
    isAssistantMessageWithContent(message) &&
    message.content.some(isToolCallBlock) &&
    messages.some(
      (next, nextIndex) =>
        nextIndex > index && next && typeof next === "object" && next.role === "toolResult",
    )
    ? index
    : -1;
}

export function shouldPreserveLatestAssistantThinking(messages: AgentMessage[]): boolean {
  const latestAssistantIndex = messages.findLastIndex(isAssistantMessageWithContent);
  return (
    latestAssistantIndex >= 0 &&
    (latestAssistantIndex === messages.length - 1 ||
      latestAssistantIndex === findCurrentToolTurnAssistantIndex(messages))
  );
}

export function stripThinkingBlocksFromMessage(message: AgentMessage): AgentMessage {
  if (!isAssistantMessageWithContent(message)) {
    return message;
  }
  return filterAssistantContent(message, (block) => !isThinkingLikeBlock(block));
}

export function stripAllThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  return mapAssistantMessages(messages, stripThinkingBlocksFromMessage);
}

export function dropReasoningFromHistory(messages: AgentMessage[]): AgentMessage[] {
  const currentToolTurnAssistantIndex = findCurrentToolTurnAssistantIndex(messages);
  return mapAssistantMessages(messages, (message, index) =>
    index === currentToolTurnAssistantIndex ? message : stripThinkingBlocksFromMessage(message),
  );
}
