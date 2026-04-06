import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

const MINIMAX_FAST_MODEL_IDS = new Map<string, string>([
  ["MiniMax-M2.7", "MiniMax-M2.7-highspeed"],
]);

function resolveMinimaxFastModelId(modelId: unknown): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  return MINIMAX_FAST_MODEL_IDS.get(modelId.trim());
}

function isMinimaxAnthropicMessagesModel(model: { api?: unknown; provider?: unknown }): boolean {
  return (
    model.api === "anthropic-messages" &&
    (model.provider === "minimax" || model.provider === "minimax-portal")
  );
}

export function createMinimaxFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      !fastMode ||
      model.api !== "anthropic-messages" ||
      (model.provider !== "minimax" && model.provider !== "minimax-portal")
    ) {
      return underlying(model, context, options);
    }

    const fastModelId = resolveMinimaxFastModelId(model.id);
    if (!fastModelId) {
      return underlying(model, context, options);
    }

    return underlying({ ...model, id: fastModelId }, context, options);
  };
}

/**
 * MiniMax's Anthropic-compatible streaming endpoint implements reasoning
 * natively but does NOT support the Anthropic extended thinking protocol
 * (i.e. sending `thinking: { type: "enabled", budget_tokens: N }` in the
 * request payload). When a thinking payload is forwarded, MiniMax returns
 * reasoning output as OpenAI-style `reasoning_content` deltas rather than
 * Anthropic `thinking` content blocks. Pi-ai's Anthropic stream handler
 * cannot parse this format, causing the raw reasoning text to leak into the
 * visible assistant reply.
 *
 * OpenClaw's Anthropic transport sets `thinking: { type: "enabled" }` for any
 * model with `reasoning: true` whenever a thinking level is active (which is
 * the default for MiniMax M2.7). This wrapper unconditionally overrides that
 * to `thinking: { type: "disabled" }` for every MiniMax Anthropic-messages
 * request, ensuring MiniMax performs its reasoning silently without leaking
 * content into the response stream.
 */
export function createMinimaxThinkingDisabledWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (!isMinimaxAnthropicMessagesModel(model)) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          // Always override to disabled. MiniMax does not support the Anthropic
          // extended thinking protocol and returns reasoning_content in OpenAI
          // delta format instead. Sending thinking:enabled causes that content
          // to leak into the visible reply, so we must suppress it regardless
          // of what the upstream transport layer set.
          payloadObj.thinking = { type: "disabled" };
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
