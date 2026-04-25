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
 * Placeholder text used when all content blocks in an assistant message were
 * thinking-only.  This must be a **non-empty** string because downstream
 * provider converters (Bedrock `convertMessages`, Anthropic
 * `convertAnthropicMessages`) filter out text blocks whose
 * `text.trim().length === 0`, which would leave the assistant message with an
 * empty `content` array and trigger a Bedrock `ValidationException`:
 *
 *   "The content field in the Message object at messages.N is empty."
 *
 * Using a visible placeholder keeps the turn intact across all providers.
 */
const THINKING_DROPPED_PLACEHOLDER = "[thinking]";

/**
 * Strip all `type: "thinking"` content blocks from assistant messages.
 *
 * If an assistant message becomes empty after stripping, it is replaced with
 * a synthetic text block containing {@link THINKING_DROPPED_PLACEHOLDER} to
 * preserve turn structure (some providers require strict user/assistant
 * alternation and reject empty content arrays).
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
    // The placeholder MUST be non-empty — see THINKING_DROPPED_PLACEHOLDER.
    const content =
      nextContent.length > 0
        ? nextContent
        : [{ type: "text", text: THINKING_DROPPED_PLACEHOLDER } as AssistantContentBlock];
    out.push({ ...msg, content });
  }
  return touched ? out : messages;
}
