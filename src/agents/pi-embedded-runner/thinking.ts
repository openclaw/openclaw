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
 * Minimum length for a valid Anthropic thinking block signature.
 * Real signatures from Claude are 356-2344+ characters. An empty string
 * or very short value is always invalid and will cause API rejection.
 */
const MIN_VALID_SIGNATURE_LENGTH = 10;

/**
 * Strip thinking blocks that have empty or invalid `thinkingSignature` from
 * assistant messages. This prevents Anthropic API rejection errors like
 * "Invalid signature in thinking block" caused by empty signatures that were
 * persisted from Bedrock streaming responses.
 *
 * Unlike `dropThinkingBlocks` which removes ALL thinking blocks, this function
 * only removes thinking blocks with missing/invalid signatures while preserving
 * validly-signed ones.
 *
 * Returns the original array reference when nothing was changed.
 */
export function stripInvalidThinkingSignatures(messages: AgentMessage[]): AgentMessage[] {
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
      if (!block || typeof block !== "object") {
        nextContent.push(block);
        continue;
      }
      const rec = block as { type?: unknown; thinkingSignature?: unknown };
      if (rec.type !== "thinking") {
        nextContent.push(block);
        continue;
      }
      // Thinking block — validate its signature
      const sig = rec.thinkingSignature;
      if (typeof sig === "string" && sig.length >= MIN_VALID_SIGNATURE_LENGTH) {
        // Valid signature, keep block as-is
        nextContent.push(block);
        continue;
      }
      // Missing or invalid signature — drop the thinking block to prevent
      // API rejection on replay. The thinking content is already captured
      // in the session JSONL for debugging purposes.
      touched = true;
      changed = true;
    }
    if (!changed) {
      out.push(msg);
      continue;
    }
    // Preserve the assistant turn even if all thinking blocks were stripped.
    const content =
      nextContent.length > 0 ? nextContent : [{ type: "text", text: "" } as AssistantContentBlock];
    out.push({ ...msg, content });
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
