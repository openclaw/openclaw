import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * Merges consecutive assistant messages together.
 */
export function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result: AgentMessage[] = [];
  let lastRole: string | undefined;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (!msgRole) {
      result.push(msg);
      continue;
    }

    if (msgRole === lastRole && lastRole === "assistant") {
      const lastMsg = result[result.length - 1];
      const currentMsg = msg as Extract<AgentMessage, { role: "assistant" }>;

      if (lastMsg && typeof lastMsg === "object") {
        const lastAsst = lastMsg as Extract<AgentMessage, { role: "assistant" }>;
        const mergedContent = [
          ...(Array.isArray(lastAsst.content) ? lastAsst.content : []),
          ...(Array.isArray(currentMsg.content) ? currentMsg.content : []),
        ];

        const merged: Extract<AgentMessage, { role: "assistant" }> = {
          ...lastAsst,
          content: mergedContent,
          ...(currentMsg.usage && { usage: currentMsg.usage }),
          ...(currentMsg.stopReason && { stopReason: currentMsg.stopReason }),
          ...(currentMsg.errorMessage && {
            errorMessage: currentMsg.errorMessage,
          }),
        };

        result[result.length - 1] = merged;
        continue;
      }
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}

export function mergeConsecutiveUserTurns(
  previous: Extract<AgentMessage, { role: "user" }>,
  current: Extract<AgentMessage, { role: "user" }>,
): Extract<AgentMessage, { role: "user" }> {
  const mergedContent = [
    ...(Array.isArray(previous.content) ? previous.content : []),
    ...(Array.isArray(current.content) ? current.content : []),
  ];

  return {
    ...current,
    content: mergedContent,
    timestamp: current.timestamp ?? previous.timestamp,
  };
}

/**
 * Checks if an assistant message has empty content (invalid for Anthropic API).
 */
function hasEmptyContent(msg: AgentMessage): boolean {
  if (msg.role !== "assistant") {
    return false;
  }
  const content = (msg as { content?: unknown }).content;
  if (!content) {
    return true;
  }
  if (Array.isArray(content) && content.length === 0) {
    return true;
  }
  return false;
}

/**
 * Sanitizes assistant error messages to prevent cascading API failures.
 * - Empty content errors are removed entirely (invalid for Anthropic API)
 * - Partial content errors are salvaged by stripping error metadata
 */
function sanitizeAssistantErrors(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    const stopReason = (msg as { stopReason?: unknown }).stopReason;
    if (role !== "assistant" || stopReason !== "error") {
      result.push(msg);
      continue;
    }
    // Assistant message with stopReason: "error"
    if (hasEmptyContent(msg)) {
      // Case 1: Empty content - remove entirely (invalid for Anthropic API)
      continue;
    }
    // Case 2: Has content - salvage by converting to normal stop
    const sanitized = { ...msg } as unknown as Record<string, unknown>;
    sanitized.stopReason = "stop";
    delete sanitized.errorMessage;
    result.push(sanitized as unknown as AgentMessage);
  }
  return result;
}

/**
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern.
 * Merges consecutive user messages together.
 * Also sanitizes error assistant messages to prevent cascading failures.
 */
export function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  // First pass: sanitize assistant error messages
  const sanitized = sanitizeAssistantErrors(messages);

  const result: AgentMessage[] = [];
  let lastRole: string | undefined;

  for (const msg of sanitized) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (!msgRole) {
      result.push(msg);
      continue;
    }

    if (msgRole === lastRole && lastRole === "user") {
      const lastMsg = result[result.length - 1];
      const currentMsg = msg as Extract<AgentMessage, { role: "user" }>;

      if (lastMsg && typeof lastMsg === "object") {
        const lastUser = lastMsg as Extract<AgentMessage, { role: "user" }>;
        const merged = mergeConsecutiveUserTurns(lastUser, currentMsg);
        result[result.length - 1] = merged;
        continue;
      }
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}
