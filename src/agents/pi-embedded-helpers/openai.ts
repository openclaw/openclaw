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
 * Detect whether a thinkingSignature is a proper round-trippable value (JSON reasoning item
 * or base64 crypto signature) versus a bare field-name artifact from the openai-completions
 * streaming path (e.g. "reasoning_text", "reasoning_content", "reasoning").
 *
 * Field-name artifacts cannot be round-tripped: openai-responses will crash at JSON.parse,
 * and openai-completions will send a bare reasoning field that Copilot/Anthropic rejects
 * with "Invalid signature in thinking block".
 */
function isRoundTrippableThinkingSignature(value: unknown): boolean {
  if (!value) {
    return false;
  }
  if (typeof value !== "string") {
    // Object signatures (already parsed reasoning items) are round-trippable.
    return typeof value === "object";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  // JSON reasoning item (from openai-responses): starts with '{'
  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  // Known field-name artifacts from openai-completions reasoning extraction.
  // These are simple identifiers, not crypto signatures.
  const KNOWN_FIELD_NAMES = ["reasoning_text", "reasoning_content", "reasoning"];
  if (KNOWN_FIELD_NAMES.includes(trimmed)) {
    return false;
  }
  // Base64 signature (from Antigravity/Anthropic): only base64 chars and
  // at least 32 characters long (real crypto signatures are 100s+ chars).
  if (trimmed.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
    return true;
  }
  // Short alphanumeric strings that aren't known field names — treat as non-round-trippable.
  return false;
}

/**
 * Strip thinking blocks whose `thinkingSignature` is a bare field-name artifact from the
 * openai-completions streaming path. These blocks cannot be properly round-tripped through
 * either openai-responses or openai-completions → Copilot proxy → Anthropic.
 *
 * The thinking content is preserved as a text block so context is not silently lost.
 */
export function stripInvalidThinkingSignatures(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  let strippedCount = 0;

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
    for (const block of assistantMsg.content) {
      if (!block || typeof block !== "object") {
        nextContent.push(block as AssistantContentBlock);
        continue;
      }
      const record = block as OpenAIThinkingBlock;
      if (record.type !== "thinking") {
        nextContent.push(block);
        continue;
      }
      // No signature at all — keep as-is (provider handles this).
      if (!record.thinkingSignature) {
        nextContent.push(block);
        continue;
      }
      const isRoundTrippable = isRoundTrippableThinkingSignature(record.thinkingSignature);
      // Valid round-trippable signature — keep.
      if (isRoundTrippable) {
        nextContent.push(block);
        continue;
      }
      // Field-name artifact — convert thinking content to text so context is not lost.
      const thinkingText = typeof record.thinking === "string" ? record.thinking.trim() : "";
      if (thinkingText) {
        nextContent.push({ type: "text", text: thinkingText } as unknown as AssistantContentBlock);
      }
      strippedCount++;
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

  if (strippedCount > 0) {
    console.warn(
      `[thinking-sig] Stripped ${strippedCount} non-round-trippable thinking signature(s) from session history`,
    );
  }

  return out;
}

/**
 * Convert all thinking blocks that carry a `thinkingSignature` into plain text blocks.
 *
 * Thinking signatures are provider-specific (OpenAI JSON reasoning items vs Anthropic/
 * Antigravity base64 crypto signatures vs openai-completions field-name artifacts).
 * When the model/provider changes between conversation turns, old signatures become invalid
 * for the new provider — e.g. an OpenAI `{"id":"rs_...","type":"reasoning"}` signature sent
 * via Copilot to Claude produces "Invalid signature in thinking block" (HTTP 400).
 *
 * This function converts signed thinking blocks to text blocks so the reasoning context is
 * preserved without poisoning the new provider. Unsigned thinking blocks (no signature) are
 * kept as-is since providers can handle those natively.
 */
export function downgradeThinkingBlocksOnModelSwitch(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  let downgraded = 0;

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
    for (const block of assistantMsg.content) {
      if (!block || typeof block !== "object") {
        nextContent.push(block as AssistantContentBlock);
        continue;
      }
      const record = block as OpenAIThinkingBlock;
      if (record.type !== "thinking") {
        nextContent.push(block);
        continue;
      }
      // No signature — keep as-is (provider-neutral thinking).
      if (!record.thinkingSignature) {
        nextContent.push(block);
        continue;
      }
      // Has a signature from the previous provider — convert to text.
      const thinkingText = typeof record.thinking === "string" ? record.thinking.trim() : "";
      if (thinkingText) {
        nextContent.push({ type: "text", text: thinkingText } as unknown as AssistantContentBlock);
      }
      downgraded++;
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

  if (downgraded > 0) {
    console.warn(
      `[thinking-sig] Downgraded ${downgraded} signed thinking block(s) to text on model switch`,
    );
  }

  return out;
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
