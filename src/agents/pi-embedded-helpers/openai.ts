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

export type OpenAIResponseChoice = {
  index?: number;
  message?: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: unknown[];
  };
  finish_reason?: string;
};

export type OpenAIResponse = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: OpenAIResponseChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
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

/**
 * Maps non-standard `reasoning_content` field (used by iflow/GLM-4.6)
 * to OpenClaw's structured thinking blocks.
 */
export function mapOpenAIReasoningContent(choice: OpenAIResponseChoice): Array<{
  type: "thinking" | "text";
  thinking?: string;
  text?: string;
}> {
  const message = choice.message;
  if (!message) {
    return [];
  }

  const blocks: Array<{ type: "thinking" | "text"; thinking?: string; text?: string }> = [];

  if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
    blocks.push({
      type: "thinking",
      thinking: message.reasoning_content.trim(),
    });
  }

  if (typeof message.content === "string" && message.content.trim()) {
    blocks.push({
      type: "text",
      text: message.content.trim(),
    });
  }

  return blocks;
}

/**
 * Maps OpenAI-compatible usage to OpenClaw's internal usage representation,
 * including reasoning tokens if present.
 */
export function mapOpenAIUsage(usage?: OpenAIResponse["usage"]): {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
} | undefined {
  if (!usage) {
    return undefined;
  }

  const reasoning_tokens =
    usage.completion_tokens_details?.reasoning_tokens ?? (usage as any).reasoning_tokens;

  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    reasoning_tokens: typeof reasoning_tokens === "number" ? reasoning_tokens : undefined,
  };
}
