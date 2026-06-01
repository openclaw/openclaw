import type { ProviderSanitizeReplayHistoryContext } from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const COPILOT_ANTHROPIC_OMITTED_THINKING_TEXT = "[assistant reasoning omitted]";

type ReplayMessage = ProviderSanitizeReplayHistoryContext["messages"][number];

function isCopilotClaudeModel(modelId?: string | null): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("claude");
}

function isThinkingBlock(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    ((value as { type?: unknown }).type === "thinking" ||
      (value as { type?: unknown }).type === "redacted_thinking")
  );
}

function stripAssistantThinkingReplay(message: ReplayMessage): ReplayMessage {
  if (!message || typeof message !== "object") {
    return message;
  }
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "assistant" || !Array.isArray(record.content)) {
    return message;
  }

  const nextContent = record.content.filter((block) => !isThinkingBlock(block));
  if (nextContent.length === record.content.length) {
    return message;
  }
  return {
    ...(message as unknown as Record<string, unknown>),
    content:
      nextContent.length > 0
        ? nextContent
        : [{ type: "text", text: COPILOT_ANTHROPIC_OMITTED_THINKING_TEXT }],
  } as ReplayMessage;
}

export function buildGithubCopilotReplayPolicy(modelId?: string) {
  return isCopilotClaudeModel(modelId)
    ? {
        dropThinkingBlocks: true,
      }
    : {};
}

export function sanitizeGithubCopilotReplayHistory(ctx: ProviderSanitizeReplayHistoryContext) {
  if (!isCopilotClaudeModel(ctx.modelId)) {
    return ctx.messages;
  }

  let touched = false;
  const messages = ctx.messages.map((message) => {
    const next = stripAssistantThinkingReplay(message);
    touched ||= next !== message;
    return next;
  });
  return touched ? messages : ctx.messages;
}
