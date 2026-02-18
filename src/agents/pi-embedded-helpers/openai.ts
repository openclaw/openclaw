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

// These block types are producer-only artifacts in OpenAI replay streams and do NOT
// satisfy the "required following item" rule for reasoning items.
const OPENAI_REPLAY_PRODUCER_TYPES = new Set(["toolCall", "toolUse", "function_call"]);

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

// "User-facing" follower = any non-thinking, non-producer-only block.
// Preserve legacy semantics: missing `type` counts as a follower (historically `undefined !== "thinking"` was true).
function hasFollowingUserFacingBlock(blocks: Array<{ type?: unknown }>, startIdx: number): boolean {
  for (let i = startIdx + 1; i < blocks.length; i++) {
    const block = blocks[i];

    // Preserve prior behavior: non-object blocks were treated as followers.
    if (!block || typeof block !== "object") {
      return true;
    }

    const t = (block as { type?: unknown }).type;

    // Preserve legacy semantics explicitly:
    // previously: (undefined !== "thinking") => treated as a valid follower.
    if (t === undefined) {
      return true;
    }

    // Not user-facing followers (do NOT satisfy "required following item")
    if (t === "thinking") {
      continue;
    }
    if (typeof t === "string" && OPENAI_REPLAY_PRODUCER_TYPES.has(t)) {
      continue;
    }

    // Anything else is user-facing
    return true;
  }
  return false;
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

      // Only thinking blocks can carry OpenAI reasoning signatures.
      if (record.type !== "thinking") {
        nextContent.push(block);
        continue;
      }

      const signature = parseOpenAIReasoningSignature(record.thinkingSignature);
      if (!signature) {
        nextContent.push(block);
        continue;
      }

      // If there is a valid user-facing follower, keep the thinking block.
      if (hasFollowingUserFacingBlock(assistantMsg.content as Array<{ type?: unknown }>, i)) {
        nextContent.push(block);
        continue;
      }

      // Otherwise drop the block to avoid orphan reasoning item ids in replay.
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
