import type { AgentMessage } from "@mariozechner/pi-agent-core";

type OpenAIThinkingBlock = {
  type?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
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

/**
 * Check if an assistant message contains tool calls but no thinking block.
 */
function hasToolCallWithoutThinking(
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
): boolean {
  let hasToolCall = false;
  let hasThinking = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === "toolCall") {
      hasToolCall = true;
    }
    if (type === "thinking") {
      hasThinking = true;
    }
  }
  return hasToolCall && !hasThinking;
}

/**
 * Check if any assistant message in the history has tool calls without thinking blocks.
 * This is used to detect incompatibility when switching to a reasoning-enabled model.
 */
export function hasHistoryToolCallWithoutThinking(messages: AgentMessage[]): boolean {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    if ((msg as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) {
      continue;
    }
    if (hasToolCallWithoutThinking(assistantMsg.content)) {
      return true;
    }
  }
  return false;
}

/**
 * Add empty thinking blocks to assistant messages that have tool calls but no thinking.
 * This ensures compatibility when switching to a reasoning-enabled model.
 *
 * Fixes: "400 thinking is enabled but reasoning_content is missing in assistant tool call message"
 */
export function addEmptyThinkingToToolCallMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    if ((msg as { role?: unknown }).role !== "assistant") {
      return msg;
    }
    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) {
      return msg;
    }
    if (!hasToolCallWithoutThinking(assistantMsg.content)) {
      return msg;
    }

    // Prepend an empty thinking block to satisfy API requirements
    type AssistantContentBlock = (typeof assistantMsg.content)[number];
    const emptyThinking = {
      type: "thinking" as const,
      thinking: "",
    } as AssistantContentBlock;
    return {
      ...assistantMsg,
      content: [emptyThinking, ...assistantMsg.content],
    } as AgentMessage;
  });
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
