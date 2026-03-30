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
 * Strip `thinkingSignature` from `type: "thinking"` content blocks without
 * removing the blocks themselves.
 *
 * This prevents pi-ai's `convertResponsesMessages` from replaying reasoning
 * items (which some providers like Azure OpenAI reject) while preserving the
 * thinking text for display.
 *
 * Returns the original array reference when nothing was changed.
 */
export function stripThinkingSignatures(messages: AgentMessage[]): AgentMessage[] {
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
      const b = block as { type?: unknown; thinkingSignature?: unknown };
      if (b && typeof b === "object" && b.type === "thinking" && b.thinkingSignature) {
        touched = true;
        changed = true;
        const { thinkingSignature: _, ...rest } = b as Record<string, unknown>;
        nextContent.push(rest as unknown as AssistantContentBlock);
        continue;
      }
      nextContent.push(block);
    }
    if (!changed) {
      out.push(msg);
      continue;
    }
    out.push({ ...msg, content: nextContent });
  }
  return touched ? out : messages;
}
