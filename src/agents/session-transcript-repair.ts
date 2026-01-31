import type { AgentMessage } from "@mariozechner/pi-agent-core";

type ToolCallLike = {
  id: string;
  name?: string;
};

/**
 * Check if a content block is a valid tool_use/toolCall/functionCall block.
 * Returns true for non-tool blocks (they pass through) and valid tool blocks.
 * Returns false for malformed tool blocks that should be stripped.
 */
function isValidToolUseBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return true; // Non-objects pass through
  }
  const rec = block as {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    partialJson?: unknown;
  };
  // Only validate tool-related types
  if (rec.type !== "toolCall" && rec.type !== "toolUse" && rec.type !== "functionCall") {
    return true;
  }
  // Malformed: missing/invalid id or has partialJson (indicates interrupted serialization)
  // Note: missing `name` is tolerable - extractToolCallsFromAssistant handles it gracefully
  if (typeof rec.id !== "string" || !rec.id) {
    return false;
  }
  if (rec.partialJson !== undefined) {
    return false;
  }
  return true;
}

/**
 * Strip malformed tool_use blocks from assistant messages.
 * This must run BEFORE pairing repair to prevent creating synthetic results for invalid blocks.
 */
function stripMalformedToolUseBlocks(messages: AgentMessage[]): {
  messages: AgentMessage[];
  droppedMalformedCount: number;
} {
  let droppedMalformedCount = 0;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      out.push(msg);
      continue;
    }

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    const content = assistant.content;
    if (!Array.isArray(content)) {
      out.push(msg);
      continue;
    }

    const validContent = content.filter((block) => {
      const valid = isValidToolUseBlock(block);
      if (!valid) {
        droppedMalformedCount += 1;
      }
      return valid;
    });

    if (validContent.length === content.length) {
      out.push(msg);
    } else if (validContent.length === 0) {
      // Preserve assistant message with empty content to maintain transcript order/metadata
      out.push({ ...assistant, content: [] } as typeof assistant);
    } else {
      out.push({ ...assistant, content: validContent } as typeof assistant);
    }
  }

  return { messages: droppedMalformedCount > 0 ? out : messages, droppedMalformedCount };
}

function extractToolCallsFromAssistant(
  msg: Extract<AgentMessage, { role: "assistant" }>,
): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCallLike[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) {
      continue;
    }

    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: Extract<AgentMessage, { role: "toolResult" }>): string | null {
  const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
  if (typeof toolCallId === "string" && toolCallId) {
    return toolCallId;
  }
  const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId === "string" && toolUseId) {
    return toolUseId;
  }
  return null;
}

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
    timestamp: Date.now(),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

export { makeMissingToolResult };

export function sanitizeToolUseResultPairing(messages: AgentMessage[]): AgentMessage[] {
  return repairToolUseResultPairing(messages).messages;
}

export type ToolUseRepairReport = {
  messages: AgentMessage[];
  added: Array<Extract<AgentMessage, { role: "toolResult" }>>;
  droppedDuplicateCount: number;
  droppedOrphanCount: number;
  droppedMalformedToolUseCount: number;
  moved: boolean;
};

export function repairToolUseResultPairing(messages: AgentMessage[]): ToolUseRepairReport {
  // Strip malformed tool_use blocks first to prevent creating synthetic results for invalid blocks
  const { messages: cleanedMessages, droppedMalformedCount } =
    stripMalformedToolUseBlocks(messages);

  // Anthropic (and Cloud Code Assist) reject transcripts where assistant tool calls are not
  // immediately followed by matching tool results. Session files can end up with results
  // displaced (e.g. after user turns) or duplicated. Repair by:
  // - moving matching toolResult messages directly after their assistant toolCall turn
  // - inserting synthetic error toolResults for missing ids
  // - dropping duplicate toolResults for the same id (anywhere in the transcript)
  const out: AgentMessage[] = [];
  const added: Array<Extract<AgentMessage, { role: "toolResult" }>> = [];
  const seenToolResultIds = new Set<string>();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = droppedMalformedCount > 0;

  const pushToolResult = (msg: Extract<AgentMessage, { role: "toolResult" }>) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      droppedDuplicateCount += 1;
      changed = true;
      return;
    }
    if (id) {
      seenToolResultIds.add(id);
    }
    out.push(msg);
  };

  for (let i = 0; i < cleanedMessages.length; i += 1) {
    const msg = cleanedMessages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role !== "assistant") {
      // Tool results must only appear directly after the matching assistant tool call turn.
      // Any "free-floating" toolResult entries in session history can make strict providers
      // (Anthropic-compatible APIs, MiniMax, Cloud Code Assist) reject the entire request.
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    const toolCalls = extractToolCallsFromAssistant(assistant);
    if (toolCalls.length === 0) {
      out.push(msg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));

    const spanResultsById = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
    const remainder: AgentMessage[] = [];

    let j = i + 1;
    for (; j < cleanedMessages.length; j += 1) {
      const next = cleanedMessages[j];
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }

      const nextRole = (next as { role?: unknown }).role;
      if (nextRole === "assistant") {
        break;
      }

      if (nextRole === "toolResult") {
        const toolResult = next as Extract<AgentMessage, { role: "toolResult" }>;
        const id = extractToolResultId(toolResult);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount += 1;
            changed = true;
            continue;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, toolResult);
          }
          continue;
        }
      }

      // Drop tool results that don't match the current assistant tool calls.
      if (nextRole !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
    }

    out.push(msg);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      moved = true;
      changed = true;
    }

    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name,
        });
        added.push(missing);
        changed = true;
        pushToolResult(missing);
      }
    }

    for (const rem of remainder) {
      if (!rem || typeof rem !== "object") {
        out.push(rem);
        continue;
      }
      out.push(rem);
    }
    i = j - 1;
  }

  const changedOrMoved = changed || moved;
  return {
    messages: changedOrMoved ? out : cleanedMessages,
    added,
    droppedDuplicateCount,
    droppedOrphanCount,
    droppedMalformedToolUseCount: droppedMalformedCount,
    moved: changedOrMoved,
  };
}
