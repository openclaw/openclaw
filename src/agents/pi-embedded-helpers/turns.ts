import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AnthropicContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  toolUseId?: string;
};

function hasThinkingOrRedactedThinkingBlocks(message: AgentMessage): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as { type?: unknown }).type;
    return type === "thinking" || type === "redacted_thinking";
  });
}

function resolveLatestAssistantThinkingIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (hasThinkingOrRedactedThinkingBlocks(messages[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * Strips dangling tool_use blocks from assistant messages when the immediately
 * following user message does not contain a matching tool_result block.
 * This fixes the "tool_use ids found without tool_result blocks" error from Anthropic.
 */
function stripDanglingAnthropicToolUses(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  const latestAssistantThinkingIndex = resolveLatestAssistantThinkingIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (msgRole !== "assistant") {
      result.push(msg);
      continue;
    }

    // Anthropic rejects retries when the latest assistant message contains
    // thinking/redacted_thinking blocks that were modified in any way.
    // Preserve that message exactly as-is.
    if (i === latestAssistantThinkingIndex) {
      result.push(msg);
      continue;
    }

    const assistantMsg = msg as {
      content?: AnthropicContentBlock[];
    };

    // Get the next message to check for tool_result blocks
    const nextMsg = messages[i + 1];
    const nextMsgRole =
      nextMsg && typeof nextMsg === "object"
        ? ((nextMsg as { role?: unknown }).role as string | undefined)
        : undefined;

    // If next message is not user, keep the assistant message as-is
    if (nextMsgRole !== "user") {
      result.push(msg);
      continue;
    }

    // Collect tool_use_ids from the next user message's tool_result blocks
    const nextUserMsg = nextMsg as {
      content?: AnthropicContentBlock[];
    };
    const validToolUseIds = new Set<string>();
    if (Array.isArray(nextUserMsg.content)) {
      for (const block of nextUserMsg.content) {
        if (block && block.type === "toolResult" && block.toolUseId) {
          validToolUseIds.add(block.toolUseId);
        }
      }
    }

    // Filter out tool_use blocks that don't have matching tool_result
    const originalContent = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
    const filteredContent = originalContent.filter((block) => {
      if (!block) {
        return false;
      }
      if (block.type !== "toolUse") {
        return true;
      }
      // Keep tool_use if its id is in the valid set
      return validToolUseIds.has(block.id || "");
    });

    // If all content would be removed, insert a minimal fallback text block
    if (originalContent.length > 0 && filteredContent.length === 0) {
      result.push({
        ...assistantMsg,
        content: [{ type: "text", text: "[tool calls omitted]" }],
      } as AgentMessage);
    } else {
      result.push({
        ...assistantMsg,
        content: filteredContent,
      } as AgentMessage);
    }
  }

  return result;
}

function validateTurnsWithConsecutiveMerge<TRole extends "assistant" | "user">(params: {
  messages: AgentMessage[];
  role: TRole;
  merge: (
    previous: Extract<AgentMessage, { role: TRole }>,
    current: Extract<AgentMessage, { role: TRole }>,
  ) => Extract<AgentMessage, { role: TRole }>;
}): AgentMessage[] {
  const { messages, role, merge } = params;
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

    if (msgRole === lastRole && lastRole === role) {
      const lastMsg = result[result.length - 1];
      const currentMsg = msg as Extract<AgentMessage, { role: TRole }>;

      if (lastMsg && typeof lastMsg === "object") {
        const lastTyped = lastMsg as Extract<AgentMessage, { role: TRole }>;
        result[result.length - 1] = merge(lastTyped, currentMsg);
        continue;
      }
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result;
}

function mergeConsecutiveAssistantTurns(
  previous: Extract<AgentMessage, { role: "assistant" }>,
  current: Extract<AgentMessage, { role: "assistant" }>,
): Extract<AgentMessage, { role: "assistant" }> {
  const mergedContent = [
    ...(Array.isArray(previous.content) ? previous.content : []),
    ...(Array.isArray(current.content) ? current.content : []),
  ];
  return {
    ...previous,
    content: mergedContent,
    ...(current.usage && { usage: current.usage }),
    ...(current.stopReason && { stopReason: current.stopReason }),
    ...(current.errorMessage && {
      errorMessage: current.errorMessage,
    }),
  };
}

/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * Merges consecutive assistant messages together.
 */
export function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
  return validateTurnsWithConsecutiveMerge({
    messages,
    role: "assistant",
    merge: mergeConsecutiveAssistantTurns,
  });
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
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern.
 * Merges consecutive user messages together.
 * Also strips dangling tool_use blocks that lack corresponding tool_result blocks.
 */
export function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
  // First, strip dangling tool_use blocks from assistant messages
  const stripped = stripDanglingAnthropicToolUses(messages);

  return validateTurnsWithConsecutiveMerge({
    messages: stripped,
    role: "user",
    merge: mergeConsecutiveUserTurns,
  });
}
