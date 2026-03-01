import type { AgentMessage } from "@mariozechner/pi-agent-core";

type OpenAIThinkingBlock = {
  type?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
};

type OpenAIToolCallBlock = {
  type?: unknown;
  id?: unknown;
};

type OpenAIReasoningSignature = {
  id: string;
  type: string;
};

function parseOpenAIReasoningSignature(value: unknown): OpenAIReasoningSignature | null {
  if (!value) {
    return null;
  }
  let candidate: { id?: unknown; type?: unknown } | null = null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }
    try {
      candidate = JSON.parse(trimmed) as { id?: unknown; type?: unknown };
    } catch {
      return null;
    }
  } else if (typeof value === "object") {
    candidate = value as { id?: unknown; type?: unknown };
  }
  if (!candidate) {
    return null;
  }
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const type = typeof candidate.type === "string" ? candidate.type : "";
  if (!id.startsWith("rs_")) {
    return null;
  }
  if (type === "reasoning" || type.startsWith("reasoning.")) {
    return { id, type };
  }
  return null;
}

function hasFollowingNonThinkingBlock(
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
  index: number,
): boolean {
  for (let i = index + 1; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== "object") {
      return true;
    }
    if ((block as { type?: unknown }).type !== "thinking") {
      return true;
    }
  }
  return false;
}

function splitOpenAIFunctionCallPairing(id: string): {
  callId: string;
  itemId?: string;
} {
  const separator = id.indexOf("|");
  if (separator <= 0 || separator >= id.length - 1) {
    return { callId: id };
  }
  return {
    callId: id.slice(0, separator),
    itemId: id.slice(separator + 1),
  };
}

function isOpenAIToolCallType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

/**
 * OpenAI can reject replayed `function_call` items with an `fc_*` id if the
 * matching `reasoning` item is absent in the same assistant turn.
 *
 * When that pairing is missing, strip the `|fc_*` suffix from tool call ids so
 * pi-ai omits `function_call.id` on replay.
 */
export function downgradeOpenAIFunctionCallReasoningPairs(
  messages: AgentMessage[],
): AgentMessage[] {
  const rewrittenIds = new Map<string, string>();
  let changed = false;

  const rewrittenAssistantMessages = messages.map((msg) => {
    if (!msg || typeof msg !== "object" || (msg as { role?: unknown }).role !== "assistant") {
      return msg;
    }
    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) {
      return msg;
    }

    let seenReplayableReasoning = false;
    let assistantChanged = false;
    const nextContent = assistantMsg.content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }

      const thinkingBlock = block as OpenAIThinkingBlock;
      if (
        thinkingBlock.type === "thinking" &&
        parseOpenAIReasoningSignature(thinkingBlock.thinkingSignature)
      ) {
        seenReplayableReasoning = true;
        return block;
      }

      const toolCallBlock = block as OpenAIToolCallBlock;
      if (!isOpenAIToolCallType(toolCallBlock.type) || typeof toolCallBlock.id !== "string") {
        return block;
      }

      const pairing = splitOpenAIFunctionCallPairing(toolCallBlock.id);
      if (seenReplayableReasoning || !pairing.itemId || !pairing.itemId.startsWith("fc_")) {
        return block;
      }

      assistantChanged = true;
      rewrittenIds.set(toolCallBlock.id, pairing.callId);
      return {
        ...(block as unknown as Record<string, unknown>),
        id: pairing.callId,
      } as typeof block;
    });

    if (!assistantChanged) {
      return msg;
    }
    changed = true;
    return { ...assistantMsg, content: nextContent } as AgentMessage;
  });

  if (rewrittenIds.size === 0) {
    return messages;
  }

  const rewrittenMessages = rewrittenAssistantMessages.map((msg) => {
    if (!msg || typeof msg !== "object" || (msg as { role?: unknown }).role !== "toolResult") {
      return msg;
    }
    const toolResult = msg as Extract<AgentMessage, { role: "toolResult" }> & {
      toolUseId?: unknown;
    };
    let toolResultChanged = false;
    const updates: Record<string, string> = {};

    if (typeof toolResult.toolCallId === "string") {
      const nextToolCallId = rewrittenIds.get(toolResult.toolCallId);
      if (nextToolCallId && nextToolCallId !== toolResult.toolCallId) {
        updates.toolCallId = nextToolCallId;
        toolResultChanged = true;
      }
    }

    if (typeof toolResult.toolUseId === "string") {
      const nextToolUseId = rewrittenIds.get(toolResult.toolUseId);
      if (nextToolUseId && nextToolUseId !== toolResult.toolUseId) {
        updates.toolUseId = nextToolUseId;
        toolResultChanged = true;
      }
    }

    if (!toolResultChanged) {
      return msg;
    }
    changed = true;
    return {
      ...toolResult,
      ...updates,
    } as AgentMessage;
  });

  return changed ? rewrittenMessages : messages;
}

/**
 * OpenAI Responses API can reject transcripts that contain a standalone `reasoning` item id
 * without the required following item.
 *
 * OpenClaw persists provider-specific reasoning metadata in `thinkingSignature`; if that metadata
 * is incomplete, drop the block to keep history usable.
 */
export function downgradeOpenAIReasoningBlocks(messages: AgentMessage[]): AgentMessage[] {
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

    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) {
      out.push(msg);
      continue;
    }

    let changed = false;
    type AssistantContentBlock = (typeof assistantMsg.content)[number];

    const nextContent: AssistantContentBlock[] = [];
    for (let i = 0; i < assistantMsg.content.length; i++) {
      const block = assistantMsg.content[i];
      if (!block || typeof block !== "object") {
        nextContent.push(block as AssistantContentBlock);
        continue;
      }
      const record = block as OpenAIThinkingBlock;
      if (record.type !== "thinking") {
        nextContent.push(block);
        continue;
      }
      const signature = parseOpenAIReasoningSignature(record.thinkingSignature);
      if (!signature) {
        nextContent.push(block);
        continue;
      }
      if (hasFollowingNonThinkingBlock(assistantMsg.content, i)) {
        nextContent.push(block);
        continue;
      }
      changed = true;
    }

    if (!changed) {
      out.push(msg);
      continue;
    }

    if (nextContent.length === 0) {
      continue;
    }

    out.push({ ...assistantMsg, content: nextContent } as AgentMessage);
  }

  return out;
}
