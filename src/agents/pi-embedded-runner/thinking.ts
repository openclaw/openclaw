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
 * Strip thinking blocks that have obviously invalid `thinkingSignature` from
 * assistant messages. This prevents Anthropic API rejection errors like
 * "Invalid signature in thinking block" caused by empty signatures that were
 * persisted from Bedrock streaming responses.
 *
 * Only strips thinking blocks with missing, empty, or non-string signatures —
 * the clearly broken cases. Does NOT attempt length-based heuristics to guess
 * whether a signature is valid; the API itself is the authoritative validator.
 * If a corrupt but non-empty signature slips through, the caller should catch
 * the resulting API error and fall back to `dropThinkingBlocks` (see run.ts).
 *
 * Unlike `dropThinkingBlocks` which removes ALL thinking blocks, this function
 * preserves thinking blocks that have a non-empty string signature.
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
      // Thinking block — check for obviously invalid signatures.
      // A valid signature must be a non-empty string. We intentionally avoid
      // length thresholds; the API is the source of truth for signature validity.
      const sig = rec.thinkingSignature;
      if (typeof sig === "string" && sig.length > 0) {
        // Has a non-empty signature — keep block as-is and let the API validate.
        nextContent.push(block);
        continue;
      }
      // Missing, empty, or non-string signature — drop the thinking block to
      // prevent API rejection on replay. The thinking content is already
      // captured in the session JSONL for debugging purposes.
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
 * Returns true if the given error message indicates an Anthropic
 * "Invalid signature in thinking block" rejection.
 */
export function isInvalidThinkingSignatureError(errorText: string): boolean {
  return /invalid signature in thinking block/i.test(errorText);
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
