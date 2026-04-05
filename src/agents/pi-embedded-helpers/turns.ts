import type { AgentMessage } from "@mariozechner/pi-agent-core";

// Extend this union when pi-agent-core adds new tool-call block types
type AnthropicContentBlock = {
  type: "text" | "toolUse" | "toolResult" | "toolCall" | "functionCall";
  text?: string;
  id?: string;
  name?: string;
  toolUseId?: string;
  toolCallId?: string;
  tool_use_id?: string;
  tool_call_id?: string;
};

/** Recognizes toolUse, toolCall, and functionCall block types from different providers/core versions */
function isToolCallBlock(type: string | undefined): boolean {
  return type === "toolUse" || type === "toolCall" || type === "functionCall";
}

function isAbortedAssistantTurn(msg: AgentMessage): boolean {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const stopReason = (msg as { stopReason?: unknown }).stopReason;
  return stopReason === "error" || stopReason === "aborted";
}

/**
 * Strips dangling assistant tool-call blocks (toolUse/toolCall/functionCall)
 * when no later message in the same assistant span contains a matching
 * tool_result block. This fixes the "tool_use ids found without tool_result
 * blocks" error from Anthropic. Aborted/error turns are still filtered for
 * dangling tool calls, but they do not receive synthesized fallback text.
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

    const isAbortedTurn = isAbortedAssistantTurn(msg);

    if (!Array.isArray(assistantMsg.content)) {
      result.push(msg);
      continue;
    }

    // Scan ALL subsequent messages in this assistant span for matching tool_result blocks.
    // OpenAI-compatible transcripts can have assistant(toolCall) → user(text) → toolResult
    // ordering, so we must look beyond the immediate next message.
    // TODO: optimize to single-pass suffix set if this helper becomes hot.
    const validToolUseIds = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const futureMsg = messages[j];
      if (!futureMsg || typeof futureMsg !== "object") {
        continue;
      }
      const futureRole = (futureMsg as { role?: unknown }).role as string | undefined;
      if (futureRole === "assistant") {
        break;
      }
      if (futureRole !== "user" && futureRole !== "toolResult" && futureRole !== "tool") {
        continue;
      }
      const futureUserMsg = futureMsg as {
        content?: AnthropicContentBlock[];
        toolUseId?: string;
        toolCallId?: string;
        tool_use_id?: string;
        tool_call_id?: string;
      };
      if (futureRole === "toolResult" || futureRole === "tool") {
        const directToolResultId =
          futureUserMsg.toolUseId ??
          futureUserMsg.toolCallId ??
          futureUserMsg.tool_use_id ??
          futureUserMsg.tool_call_id;
        if (directToolResultId) {
          validToolUseIds.add(directToolResultId);
        }
      }
      if (!Array.isArray(futureUserMsg.content)) {
        continue;
      }
      for (const block of futureUserMsg.content) {
        if (block && block.type === "toolResult") {
          const toolResultId =
            block.toolUseId ?? block.toolCallId ?? block.tool_use_id ?? block.tool_call_id;
          if (toolResultId) {
            validToolUseIds.add(toolResultId);
          }
        }
      }
    }

    // Filter out tool-call blocks that don't have matching tool_result
    const originalContent = assistantMsg.content;
    const filteredContent = originalContent.filter((block) => {
      if (!block) {
        return false;
      }
      if (!isToolCallBlock(block.type)) {
        return true;
      }
      // Keep tool call if its id is in the valid set
      return validToolUseIds.has(block.id || "");
    });

    // If all content would be removed, insert a minimal fallback text block for non-aborted turns.
    if (originalContent.length > 0 && filteredContent.length === 0 && !isAbortedTurn) {
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

  // See also: main loop tool_use stripping above
  // Handle end-of-conversation orphans: if the last message is assistant with
  // tool-call blocks and no following user message, strip those blocks.
  if (result.length > 0) {
    const lastMsg = result[result.length - 1];
    const lastRole =
      lastMsg && typeof lastMsg === "object"
        ? ((lastMsg as { role?: unknown }).role as string | undefined)
        : undefined;
    if (lastRole === "assistant") {
      const lastAssistant = lastMsg as { content?: AnthropicContentBlock[] };
      if (Array.isArray(lastAssistant.content)) {
        const hasToolUse = lastAssistant.content.some((b) => b && isToolCallBlock(b.type));
        if (hasToolUse) {
          const filtered = lastAssistant.content.filter((b) => b && !isToolCallBlock(b.type));
          result[result.length - 1] =
            filtered.length > 0 || isAbortedAssistantTurn(lastMsg)
              ? ({ ...lastAssistant, content: filtered } as AgentMessage)
              : ({
                  ...lastAssistant,
                  content: [{ type: "text" as const, text: "[tool calls omitted]" }],
                } as AgentMessage);
        }
      }
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

  // Then merge consecutive user messages
  return validateTurnsWithConsecutiveMerge({
    messages: stripped,
    role: "user",
    merge: mergeConsecutiveUserTurns,
  });
}
