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
 * Strip all `type: "thinking"` and `type: "redacted_thinking"` content blocks
 * from assistant messages.
 *
 * When `options.preserveLatestSignature` is true, thinking blocks on the
 * **latest** assistant message are kept so that providers requiring thinking
 * continuity (e.g. Anthropic Claude signature validation, Bedrock thinking)
 * can validate follow-up turns.  All thinking blocks in earlier assistant
 * messages are removed entirely.
 *
 * If an assistant message becomes empty after stripping, it is replaced with
 * a synthetic `{ type: "text", text: "" }` block to preserve turn structure
 * (some providers require strict user/assistant alternation).
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export function dropThinkingBlocks(
  messages: AgentMessage[],
  options?: { preserveLatestSignature?: boolean },
): AgentMessage[] {
  const preserveLatest = options?.preserveLatestSignature === true;

  // Find the last assistant message index so we can preserve its signatures.
  let lastAssistantIdx = -1;
  if (preserveLatest) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isAssistantMessageWithContent(messages[i])) {
        lastAssistantIdx = i;
        break;
      }
    }
  }

  let touched = false;
  const out: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isAssistantMessageWithContent(msg)) {
      out.push(msg);
      continue;
    }
    const isLatest = preserveLatest && i === lastAssistantIdx;
    const nextContent: AssistantContentBlock[] = [];
    let changed = false;
    for (const block of msg.content) {
      const blockType =
        block && typeof block === "object" ? (block as { type?: unknown }).type : undefined;
      const hasSignature =
        block &&
        typeof block === "object" &&
        ("thought_signature" in (block as unknown as Record<string, unknown>) ||
          "thinkingSignature" in (block as unknown as Record<string, unknown>));
      if (blockType === "thinking" || blockType === "redacted_thinking") {
        touched = true;
        changed = true;
        if (isLatest) {
          // Preserve latest thinking blocks for providers that require them
          // (e.g. Anthropic signature continuity, Bedrock thinking without signatures).
          nextContent.push(block);
        }
        continue;
      }
      // Also preserve blocks carrying thought_signature/thinkingSignature on
      // the latest assistant message — removing them triggers Anthropic/Bedrock
      // "cannot be modified" validation errors.
      if (hasSignature && !isLatest) {
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
