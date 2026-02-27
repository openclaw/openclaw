import type { AgentMessage } from "@mariozechner/pi-agent-core";

interface ContentBlock {
  type: string;
  thinking?: string;
  text?: string;
  signature?: string;
  [key: string]: unknown;
}

/**
 * Checks if the last assistant message has structurally valid content blocks.
 *
 * Returns 'valid' | 'incomplete-thinking' | 'incomplete-text'
 */
export function assessLastAssistantMessage(
  msg: AgentMessage,
): "valid" | "incomplete-thinking" | "incomplete-text" {
  if (msg.role !== "assistant") {
    return "valid";
  }
  if (typeof msg.content === "string") {
    return "valid";
  }
  if (!Array.isArray(msg.content) || msg.content.length === 0) {
    return "incomplete-thinking";
  }

  const blocks = msg.content as ContentBlock[];
  let hasSignedThinking = false;
  let hasUnsignedThinking = false;
  let hasNonThinkingContent = false;
  let textBlockIsEmpty = false;

  for (const block of blocks) {
    if (!block || typeof block !== "object" || !block.type) {
      return "incomplete-thinking";
    }

    if (block.type === "thinking" || block.type === "redacted_thinking") {
      if (block.type === "thinking" && !block.signature) {
        hasUnsignedThinking = true;
      } else {
        hasSignedThinking = true;
      }
    } else {
      hasNonThinkingContent = true;
      if (block.type === "text" && (!block.text || block.text.trim() === "")) {
        textBlockIsEmpty = true;
      }
    }
  }

  // Unsigned thinking = crashed during thinking phase
  if (hasUnsignedThinking) {
    return "incomplete-thinking";
  }

  // Signed thinking but no text/tool_use block at all = crashed between phases
  if (hasSignedThinking && !hasNonThinkingContent) {
    return "incomplete-text";
  }

  // Signed thinking + empty text block = crashed mid-text generation
  if (hasSignedThinking && textBlockIsEmpty) {
    return "incomplete-text";
  }

  return "valid";
}

/**
 * Sanitize the latest assistant message for crash recovery.
 */
export function sanitizeThinkingForRecovery(messages: AgentMessage[]): {
  messages: AgentMessage[];
  prefill: boolean;
} {
  if (!messages || messages.length === 0) {
    return { messages, prefill: false };
  }

  // Find the last assistant message
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  if (lastAssistantIdx === -1) {
    return { messages, prefill: false };
  }

  const lastMsg = messages[lastAssistantIdx];
  const assessment = assessLastAssistantMessage(lastMsg);

  switch (assessment) {
    case "valid":
      return { messages, prefill: false };

    case "incomplete-thinking":
      // Drop only the incomplete assistant message, preserve any subsequent turns
      return {
        messages: [...messages.slice(0, lastAssistantIdx), ...messages.slice(lastAssistantIdx + 1)],
        prefill: false,
      };

    case "incomplete-text": {
      // Valid thinking, incomplete text -> use as prefill
      return {
        messages,
        prefill: true,
      };
    }
  }
}
