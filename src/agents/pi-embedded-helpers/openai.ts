import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * pi-ai's openai-completions provider stores the reasoning field name
 * (e.g. "reasoning_text") as `thinkingSignature` instead of a real cryptographic
 * signature. When this history is replayed through a proxy that routes to
 * Anthropic (e.g. GitHub Copilot → Claude), Anthropic rejects the block:
 * `Invalid 'signature' in 'thinking' block`.
 *
 * This set lists the field names pi-ai may store as signatures.
 */
const COMPLETIONS_REASONING_FIELD_NAMES = new Set([
  "reasoning_content",
  "reasoning",
  "reasoning_text",
]);

/**
 * Strip thinking blocks whose `thinkingSignature` is a reasoning field name
 * rather than a real signature. These originate from the openai-completions
 * streaming path in pi-ai and cause 400s when replayed through providers
 * that route to Anthropic's API.
 */
export function stripCompletionsReasoningFieldSignatures(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    if ((msg as { role?: unknown }).role !== "assistant") {
      out.push(msg);
      continue;
    }

    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) {
      out.push(msg);
      continue;
    }

    let changed = false;
    type ContentBlock = (typeof assistantMsg.content)[number];
    const nextContent: ContentBlock[] = [];

    for (const block of assistantMsg.content) {
      if (!block || typeof block !== "object") {
        nextContent.push(block as ContentBlock);
        continue;
      }
      const rec = block as { type?: unknown; thinkingSignature?: unknown };
      if (rec.type !== "thinking") {
        nextContent.push(block);
        continue;
      }
      if (
        typeof rec.thinkingSignature === "string" &&
        COMPLETIONS_REASONING_FIELD_NAMES.has(rec.thinkingSignature)
      ) {
        changed = true;
        continue; // drop this block
      }
      nextContent.push(block);
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
