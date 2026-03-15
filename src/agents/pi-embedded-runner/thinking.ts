import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AssistantContentBlock = Extract<AgentMessage, { role: "assistant" }>["content"][number];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

export function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage {
  return (
    !!message &&
    typeof message === "object" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

/**
 * Strip all `type: "thinking"` content blocks from assistant messages.
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
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
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
 * For providers that require "thinking as text", convert assistant thinking
 * blocks into a leading text block and remove the original thinking blocks.
 *
 * Thinking blocks are intentionally collapsed regardless of their original
 * position (for example `[thinking, text, thinking]` becomes
 * `[combined-thinking-text, text]`) to match provider-compat replay behavior.
 *
 * This avoids downstream adapter paths that assume `assistant.content` is an
 * array and call `unshift` on it, even when provider compat can force string
 * content in the outgoing payload.
 */
export function convertThinkingBlocksToText(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }
    const thinkingTexts: string[] = [];
    const nextContent: AssistantContentBlock[] = [];
    for (const block of msg.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "thinking") {
        touched = true;
        const thinkingValue = (block as { thinking?: unknown }).thinking;
        if (typeof thinkingValue === "string" && thinkingValue.trim().length > 0) {
          thinkingTexts.push(thinkingValue);
        }
        continue;
      }
      nextContent.push(block);
    }
    if (thinkingTexts.length > 0) {
      // Keep replay deterministic by emitting one canonical leading text block.
      nextContent.unshift({
        type: "text",
        text: thinkingTexts.join("\n\n"),
      } as AssistantContentBlock);
    }
    if (nextContent.length === msg.content.length && thinkingTexts.length === 0) {
      out.push(msg);
      continue;
    }
    const content =
      nextContent.length > 0 ? nextContent : [{ type: "text", text: "" } as AssistantContentBlock];
    out.push({ ...msg, content });
  }
  return touched ? out : messages;
}
