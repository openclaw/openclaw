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
 * Preserve `thinking` blocks while removing signature fields that can be
 * rejected by provider validators when replaying persisted history.
 */
export function stripThinkingSignatures(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (!isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }

    let changed = false;
    const nextContent = msg.content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      if ((block as { type?: unknown }).type !== "thinking") {
        return block;
      }
      const rec = block as unknown as Record<string, unknown>;
      const hasThinkingSignature = Object.hasOwn(rec, "thinkingSignature");
      const hasSnakeSignature = Object.hasOwn(rec, "thinking_signature");
      const hasThoughtSignature = Object.hasOwn(rec, "thought_signature");
      const hasThoughtSignatureCamel = Object.hasOwn(rec, "thoughtSignature");
      if (
        !hasThinkingSignature &&
        !hasSnakeSignature &&
        !hasThoughtSignature &&
        !hasThoughtSignatureCamel
      ) {
        return block;
      }

      const next = { ...rec };
      delete next.thinkingSignature;
      delete next.thinking_signature;
      delete next.thought_signature;
      delete next.thoughtSignature;
      touched = true;
      changed = true;
      return next as unknown as AssistantContentBlock;
    });

    if (!changed) {
      out.push(msg);
      continue;
    }
    out.push({ ...msg, content: nextContent });
  }

  return touched ? out : messages;
}
