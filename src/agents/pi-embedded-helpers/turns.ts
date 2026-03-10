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

    // Scan forward across all consecutive user messages (and skip system
    // messages) to collect tool_result ids. This handles transcripts where
    // tool results end up in a later user message or after a system marker.
    const validToolUseIds = new Set<string>();
    let foundUser = false;
    for (let j = i + 1; j < messages.length; j++) {
      const nextMsg = messages[j];
      const nextMsgRole =
        nextMsg && typeof nextMsg === "object"
          ? ((nextMsg as { role?: unknown }).role as string | undefined)
          : undefined;
      // Stop at the next assistant message
      if (nextMsgRole === "assistant") {
        break;
      }
      // Skip system messages
      if (nextMsgRole !== "user") {
        continue;
      }
      foundUser = true;
      const nextUserMsg = nextMsg as { content?: AnthropicContentBlock[] };
      if (Array.isArray(nextUserMsg.content)) {
        for (const block of nextUserMsg.content) {
          if (block && block.type === "toolResult" && block.toolUseId) {
            validToolUseIds.add(block.toolUseId);
          }
        }
      }
    }

    // If no user message follows, keep the assistant message as-is
    if (!foundUser) {
      result.push(msg);
      continue;
    }

    // If assistant content is not an array (legacy string format), it can't
    // contain tool_use blocks, so keep it unchanged.
    if (!Array.isArray(assistantMsg.content)) {
      result.push(msg);
      continue;
    }

    // Filter out tool_use blocks that don't have matching tool_result
    const originalContent = assistantMsg.content;
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
 * Strips orphaned tool_result blocks from user messages when the immediately
 * preceding assistant message does not contain a matching tool_use block.
 * This fixes the "tool_result blocks found without matching tool_use" error from Anthropic.
 */
function stripOrphanedAnthropicToolResults(messages: AgentMessage[]): AgentMessage[] {
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

    const userMsg = msg as {
      content?: AnthropicContentBlock[];
    };

    // Scan backward to the nearest assistant message (skipping system
    // messages) to collect tool_use ids. This handles transcripts where
    // a system marker sits between the assistant and user messages.
    const validToolUseIds = new Set<string>();
    for (let j = i - 1; j >= 0; j--) {
      const prevMsg = messages[j];
      const prevMsgRole =
        prevMsg && typeof prevMsg === "object"
          ? ((prevMsg as { role?: unknown }).role as string | undefined)
          : undefined;
      // Found the nearest assistant message - collect its tool_use ids
      if (prevMsgRole === "assistant") {
        const prevAssistantMsg = prevMsg as {
          content?: AnthropicContentBlock[];
        };
        if (Array.isArray(prevAssistantMsg.content)) {
          for (const block of prevAssistantMsg.content) {
            if (block && block.type === "toolUse" && block.id) {
              validToolUseIds.add(block.id);
            }
          }
        }
        break;
      }
      // Skip system messages, stop at another user message
      if (prevMsgRole === "user") {
        break;
      }
    }

    // Filter out tool_result blocks that don't have matching tool_use
    if (!Array.isArray(userMsg.content)) {
      result.push(msg);
      continue;
    }
    const originalContent = userMsg.content;
    const filteredContent = originalContent.filter((block) => {
      if (!block) {
        return false;
      }
      if (block.type !== "toolResult") {
        return true;
      }
      // Keep tool_result if its toolUseId is in the valid set
      return validToolUseIds.has(block.toolUseId || "");
    });

    // If all content would be removed, insert a minimal fallback text block
    if (originalContent.length > 0 && filteredContent.length === 0) {
      result.push({
        ...userMsg,
        content: [{ type: "text", text: "[tool results omitted]" }],
      } as AgentMessage);
    } else {
      result.push({
        ...userMsg,
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
 * and orphaned tool_result blocks that lack corresponding tool_use blocks.
 */
export function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
  // Merge consecutive user turns first so tool pairing checks operate on
  // the post-merge transcript. Without this, a tool_result in a later
  // consecutive user message would be incorrectly stripped as "orphaned".
  const merged = validateTurnsWithConsecutiveMerge({
    messages,
    role: "user",
    merge: mergeConsecutiveUserTurns,
  });
  // Strip dangling tool_use blocks from assistant messages
  const strippedToolUses = stripDanglingAnthropicToolUses(merged);
  // Strip orphaned tool_result blocks from user messages
  return stripOrphanedAnthropicToolResults(strippedToolUses);
}
