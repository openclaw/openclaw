import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/** Block types that Anthropic considers immutable once returned. */
const THINKING_BLOCK_TYPES: ReadonlySet<string> = new Set(["thinking", "redacted_thinking"]);

function isThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return typeof type === "string" && THINKING_BLOCK_TYPES.has(type);
}

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    !!message &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

/**
 * Strip all `type: "thinking"` and `type: "redacted_thinking"` content blocks
 * from assistant messages.
 *
 * If an assistant message becomes empty after stripping, it is replaced with
 * a synthetic `{ type: "text", text: "" }` block to preserve turn structure
 * (some providers require strict user/assistant alternation).
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }
    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of msg.content) {
      if (isThinkingBlock(block)) {
        touched = true;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }
    if (!changed) {
      out.push(msg);
      continue;
    }
    // Preserve the assistant turn even if all blocks were thinking-only.
    const content =
      nextContent.length > 0 ? nextContent : [{ type: "text", text: "" } as AssistantContentBlock];
    out.push({ ...msg, content });
  }
  return touched ? out : messages;
}

/**
 * Strip `thinking` and `redacted_thinking` blocks from all assistant messages
 * **except** the latest (last) assistant message in the array.
 *
 * Anthropic requires that thinking/redacted_thinking blocks in the latest
 * assistant message remain byte-identical to the original API response.
 * Blocks in non-latest assistant messages may be omitted entirely.
 *
 * This prevents compaction or session serialization from corrupting thinking
 * blocks that are later rejected by the Anthropic API.
 *
 * Returns the original array reference when nothing was changed.
 */
export function stripThinkingFromNonLatestAssistant(messages: AgentMessage[]): AgentMessage[] {
  // Find the index of the last assistant message with array content.
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistantMessageWithContent(messages[i])) {
      lastAssistantIndex = i;
      break;
    }
  }

  // Nothing to do if there is zero or one assistant message.
  if (lastAssistantIndex <= 0) {
    return messages;
  }

  let touched = false;
  const out: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Skip non-assistant or the latest assistant — keep them as-is.
    if (i === lastAssistantIndex || !isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }

    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of msg.content) {
      if (isThinkingBlock(block)) {
        touched = true;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }

    if (!changed) {
      out.push(msg);
      continue;
    }

    const content =
      nextContent.length > 0 ? nextContent : [{ type: "text", text: "" } as AssistantContentBlock];
    out.push({ ...msg, content });
  }

  return touched ? out : messages;
}
