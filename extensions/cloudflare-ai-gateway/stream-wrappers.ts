import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

function isThinkingEnabled(payload: Record<string, unknown>): boolean {
  const thinking = payload.thinking;
  if (!thinking || typeof thinking !== "object") {
    return false;
  }
  return (thinking as { type?: unknown }).type !== "disabled";
}

function isAssistantToolUseTurn(message: Record<string, unknown>): boolean {
  const content = message.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use",
    )
  );
}

function stripTrailingAssistantPrefillWhenThinking(payload: Record<string, unknown>): void {
  if (!isThinkingEnabled(payload) || !Array.isArray(payload.messages)) {
    return;
  }

  while (payload.messages.length > 0) {
    const finalMessage = payload.messages[payload.messages.length - 1];
    if (!finalMessage || typeof finalMessage !== "object") {
      return;
    }

    const message = finalMessage as Record<string, unknown>;
    if (message.role !== "assistant" || isAssistantToolUseTurn(message)) {
      return;
    }

    payload.messages.pop();
  }
}

export function createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload }) =>
    stripTrailingAssistantPrefillWhenThinking(payload),
  );
}

export const __testing = { stripTrailingAssistantPrefillWhenThinking };
