import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return (
    api === "google-gemini-cli" || api === "google-generative-ai" || api === "google-antigravity"
  );
}

export function isAntigravityClaude(api?: string | null, modelId?: string): boolean {
  if (api !== "google-antigravity") return false;
  return modelId?.toLowerCase().includes("claude") ?? false;
}

export { sanitizeGoogleTurnOrdering };

/**
 * Drops tool calls that are missing `thought_signature` (required by Gemini)
 * to prevent 400 INVALID_ARGUMENT errors. Matching tool results are dropped
 * so they don't become orphaned in the transcript.
 */
type GeminiToolCallBlock = {
  type?: unknown;
  thought_signature?: unknown;
  thoughtSignature?: unknown;
  id?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  toolName?: unknown;
  arguments?: unknown;
  input?: unknown;
};

type GeminiThinkingBlock = {
  type?: unknown;
  thinking?: unknown;
  thinkingSignature?: unknown;
};

export function downgradeGeminiThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
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

    // Gemini rejects thinking blocks that lack a signature; downgrade to text for safety.
    let hasDowngraded = false;
    type AssistantContentBlock = (typeof assistantMsg.content)[number];
    const nextContent = assistantMsg.content.flatMap((block): AssistantContentBlock[] => {
      if (!block || typeof block !== "object") return [block as AssistantContentBlock];
      const record = block as GeminiThinkingBlock;
      if (record.type !== "thinking") return [block];
      const thinkingSig =
        typeof record.thinkingSignature === "string" ? record.thinkingSignature.trim() : "";
      if (thinkingSig.length > 0) return [block];
      const thinking = typeof record.thinking === "string" ? record.thinking : "";
      const trimmed = thinking.trim();
      hasDowngraded = true;
      if (!trimmed) return [];
      return [{ type: "text" as const, text: thinking }];
    });

    if (!hasDowngraded) {
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

export function downgradeGeminiHistory(messages: AgentMessage[]): AgentMessage[] {
  const droppedToolCallIds = new Set<string>();
  const out: AgentMessage[] = [];

  const resolveToolResultId = (
    msg: Extract<AgentMessage, { role: "toolResult" }>,
  ): string | undefined => {
    const toolCallId = (msg as { toolCallId?: unknown }).toolCallId;
    if (typeof toolCallId === "string" && toolCallId) return toolCallId;
    const toolUseId = (msg as { toolUseId?: unknown }).toolUseId;
    if (typeof toolUseId === "string" && toolUseId) return toolUseId;
    return undefined;
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
      if (!Array.isArray(assistantMsg.content)) {
        out.push(msg);
        continue;
      }

      let dropped = false;
      const nextContent = assistantMsg.content.filter((block) => {
        if (!block || typeof block !== "object") return true;
        const blockRecord = block as GeminiToolCallBlock;
        const type = blockRecord.type;
        if (type === "toolCall" || type === "functionCall" || type === "toolUse") {
          const signature = blockRecord.thought_signature ?? blockRecord.thoughtSignature;
          const hasSignature = Boolean(signature);
          if (!hasSignature) {
            const id =
              typeof blockRecord.id === "string"
                ? blockRecord.id
                : typeof blockRecord.toolCallId === "string"
                  ? blockRecord.toolCallId
                  : undefined;
            if (id) droppedToolCallIds.add(id);
            dropped = true;
            return false;
          }
        }
        return true;
      });

      if (dropped && nextContent.length === 0) {
        continue;
      }

      out.push(dropped ? ({ ...assistantMsg, content: nextContent } as AgentMessage) : msg);
      continue;
    }

    if (role === "toolResult") {
      const toolMsg = msg as Extract<AgentMessage, { role: "toolResult" }>;
      const toolResultId = resolveToolResultId(toolMsg);
      if (toolResultId && droppedToolCallIds.has(toolResultId)) {
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}
