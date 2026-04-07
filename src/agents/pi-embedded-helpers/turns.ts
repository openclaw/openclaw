import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";

type AnthropicContentBlock = {
  type: "text" | "toolUse" | "toolCall" | "functionCall" | "toolResult" | "tool";
  text?: string;
  id?: string;
  name?: string;
  toolUseId?: string;
  toolCallId?: string;
};

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isToolCallBlock(block: AnthropicContentBlock): boolean {
  return block.type === "toolUse" || block.type === "toolCall" || block.type === "functionCall";
}

function isAbortedAssistantTurn(message: AgentMessage): boolean {
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return stopReason === "aborted" || stopReason === "error";
}

function extractToolResultIdsFromRecord(record: Record<string, unknown>): string[] {
  const ids = [
    trimNonEmptyString(record.toolUseId),
    trimNonEmptyString(record.toolCallId),
    trimNonEmptyString(record.tool_use_id),
    trimNonEmptyString(record.tool_call_id),
    trimNonEmptyString(record.callId),
    trimNonEmptyString(record.call_id),
  ].filter((value): value is string => typeof value === "string");
  return [...new Set(ids)];
}

function collectMatchingToolResultIds(message: AgentMessage): Set<string> {
  const ids = new Set<string>();
  const role = (message as { role?: unknown }).role;
  if (role === "toolResult") {
    const toolResultId = extractToolResultId(
      message as Extract<AgentMessage, { role: "toolResult" }>,
    );
    if (toolResultId) {
      ids.add(toolResultId);
    }
  } else if (role === "tool") {
    for (const id of extractToolResultIdsFromRecord(
      message as unknown as Record<string, unknown>,
    )) {
      ids.add(id);
    }
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return ids;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "toolResult" && record.type !== "tool") {
      continue;
    }
    for (const id of extractToolResultIdsFromRecord(record)) {
      ids.add(id);
    }
  }

  return ids;
}

function collectFutureToolResultIds(messages: AgentMessage[], startIndex: number): Set<string> {
  const ids = new Set<string>();
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role === "assistant") {
      break;
    }
    for (const id of collectMatchingToolResultIds(candidate)) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Strips dangling tool-call blocks from assistant messages when no later
 * tool-result span before the next assistant turn resolves them.
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
    const originalContent = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
    if (originalContent.length === 0) {
      result.push(msg);
      continue;
    }
    if (
      extractToolCallsFromAssistant(msg as Extract<AgentMessage, { role: "assistant" }>).length ===
      0
    ) {
      result.push(msg);
      continue;
    }
    const validToolUseIds = collectFutureToolResultIds(messages, i);

    const filteredContent = originalContent.filter((block) => {
      if (!block) {
        return false;
      }
      if (!isToolCallBlock(block)) {
        return true;
      }
      const blockId = trimNonEmptyString(block.id);
      return blockId ? validToolUseIds.has(blockId) : false;
    });

    if (filteredContent.length === originalContent.length) {
      result.push(msg);
      continue;
    }

    if (originalContent.length > 0 && filteredContent.length === 0) {
      result.push({
        ...assistantMsg,
        content: isAbortedAssistantTurn(msg)
          ? []
          : ([{ type: "text", text: "[tool calls omitted]" }] as AnthropicContentBlock[]),
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
  // First, strip dangling tool-call blocks from assistant messages.
  const stripped = stripDanglingAnthropicToolUses(messages);

  return validateTurnsWithConsecutiveMerge({
    messages: stripped,
    role: "user",
    merge: mergeConsecutiveUserTurns,
  });
}
