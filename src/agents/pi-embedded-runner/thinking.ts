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
 * Clear `thinkingSignature` from all `type: "thinking"` content blocks in
 * assistant messages, preserving the thinking content itself.
 *
 * This is the preferred approach for providers like GitHub Copilot's Claude
 * endpoint that use the `anthropic-messages` API path. These providers return
 * real base64 cryptographic signatures, but the signatures may not round-trip
 * correctly through session persistence. Clearing the signature lets pi-ai's
 * `convertMessages` convert the thinking block to a plain text block,
 * preserving reasoning content for multi-turn tool use.
 *
 * Use this instead of `dropThinkingBlocks` when the thinking content should
 * be retained (e.g. to maintain reasoning coherence across tool calls).
 *
 * Returns the original array reference when nothing was changed.
 */
export function clearThinkingSignatures(messages: AgentMessage[]): AgentMessage[] {
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
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "thinking" &&
        (block as { thinkingSignature?: unknown }).thinkingSignature
      ) {
        touched = true;
        changed = true;
        // Keep the block but strip the signature so convertMessages
        // treats it as unsigned thinking → plain text.
        const { thinkingSignature: _, ...rest } = block as unknown as Record<string, unknown>;
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
