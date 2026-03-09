import type { AgentMessage } from "@mariozechner/pi-agent-core";

type AnthropicContentBlock = {
  type: "text" | "toolUse" | "toolResult";
  text?: string;
  id?: string;
  name?: string;
  toolUseId?: string;
};

/**
 * Strips dangling tool_use blocks from assistant messages when the immediately
 * following user message does not contain a matching tool_result block.
 * This fixes the "tool_use ids found without tool_result blocks" error from Anthropic.
 */
function stripDanglingAnthropicToolUses(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];

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
 * Strips orphaned tool_result blocks from user messages when the preceding
 * assistant message does not contain a matching tool_use block.
 * This fixes the "No tool call found for function call output" error that
 * occurs during cross-provider fallback when tool_use blocks are stripped
 * but their corresponding tool_result blocks are left behind.
 * See: https://github.com/openclaw/openclaw/issues/40433
 */
function stripOrphanedToolResults(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (msgRole !== "user") {
      result.push(msg);
      continue;
    }

    const userMsg = msg as { content?: AnthropicContentBlock[] };
    if (!Array.isArray(userMsg.content)) {
      result.push(msg);
      continue;
    }

    // Collect tool_use IDs from the preceding assistant message
    const prevMsg = i > 0 ? messages[i - 1] : null;
    const prevRole =
      prevMsg && typeof prevMsg === "object"
        ? ((prevMsg as { role?: unknown }).role as string | undefined)
        : undefined;

    const validToolUseIds = new Set<string>();
    if (prevRole === "assistant") {
      const assistantContent = (prevMsg as { content?: AnthropicContentBlock[] }).content;
      if (Array.isArray(assistantContent)) {
        for (const block of assistantContent) {
          if (
            block &&
            (block.type === "toolUse" || block.type === ("toolCall" as string) || block.type === ("functionCall" as string)) &&
            block.id
          ) {
            validToolUseIds.add(block.id);
          }
        }
      }
    }

    // Filter out tool_result blocks whose toolUseId is not in the valid set
    const filteredContent = userMsg.content.filter((block) => {
      if (!block) {
        return false;
      }
      if (block.type !== "toolResult") {
        return true;
      }
      // If no preceding assistant message, drop all tool_result blocks
      if (prevRole !== "assistant") {
        return false;
      }
      // Keep tool_result if its toolUseId matches a retained tool_use
      return validToolUseIds.has(block.toolUseId || "");
    });

    if (filteredContent.length === userMsg.content.length) {
      result.push(msg);
    } else if (filteredContent.length === 0) {
      // If all content was tool_result blocks, keep a minimal text block
      result.push({
        ...msg,
        content: [{ type: "text", text: "[tool results omitted]" }],
      } as AgentMessage);
    } else {
      result.push({
        ...msg,
        content: filteredContent,
      } as AgentMessage);
    }
  }

  return result;
}

/**
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern.
 * Merges consecutive user messages together.
 * Also strips dangling tool_use blocks that lack corresponding tool_result blocks,
 * and strips orphaned tool_result blocks that lack corresponding tool_use blocks.
 */
export function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
  // First, strip dangling tool_use blocks from assistant messages
  const stripped = stripDanglingAnthropicToolUses(messages);

  // Then strip orphaned tool_result blocks from user messages.
  // This handles the case where tool_use blocks were stripped (e.g. during
  // cross-provider fallback sanitization) but tool_result blocks were left
  // behind, causing "No tool call found for function call output" errors.
  // See: https://github.com/openclaw/openclaw/issues/40433
  const withoutOrphans = stripOrphanedToolResults(stripped);

  return validateTurnsWithConsecutiveMerge({
    messages: withoutOrphans,
    role: "user",
    merge: mergeConsecutiveUserTurns,
  });
}
