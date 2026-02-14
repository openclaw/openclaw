import type { StreamFn } from "@mariozechner/pi-agent-core";

/**
 * Apply `cache_control: { type: "ephemeral" }` to the system/developer message
 * on OpenRouter Anthropic requests.
 *
 * pi-ai's `maybeAddOpenRouterAnthropicCacheControl()` already places a breakpoint
 * on the last user/assistant message, but skips the system prompt. This wrapper
 * fills that gap by intercepting the `onPayload` callback and mutating the first
 * system/developer message in the request body.
 *
 * Anthropic supports up to 4 cache breakpoints, and OpenRouter passes them through.
 * This adds one more (going from 1 → 2 breakpoints), well within the limit.
 *
 * @see https://github.com/openclaw/openclaw/issues/15151
 */
export function wrapStreamFnWithSystemCacheControl(streamFn: StreamFn): StreamFn {
  return (model, context, options) => {
    // Only apply to OpenRouter + Anthropic models
    if (model.provider !== "openrouter" || !model.id.startsWith("anthropic/")) {
      return streamFn(model, context, options);
    }

    const originalOnPayload = options?.onPayload;

    const patchedOnPayload = (payload: unknown) => {
      if (payload && typeof payload === "object") {
        addCacheControlToSystemMessage(payload as Record<string, unknown>);
      }
      originalOnPayload?.(payload);
    };

    return streamFn(model, context, {
      ...options,
      onPayload: patchedOnPayload,
    });
  };
}

/**
 * Find the first system/developer message in the request params and add
 * `cache_control: { type: "ephemeral" }` to its last content part.
 *
 * Handles both string content (converts to content array) and array content.
 */
function addCacheControlToSystemMessage(params: Record<string, unknown>): void {
  const messages = params.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const msg = message as {
      role?: unknown;
      content?: unknown;
    };
    if (msg.role !== "system" && msg.role !== "developer") {
      continue;
    }

    const content = msg.content;

    // String content → convert to array with cache_control
    if (typeof content === "string") {
      msg.content = [
        Object.assign(
          { type: "text" as const, text: content },
          { cache_control: { type: "ephemeral" } },
        ),
      ];
      return;
    }

    // Array content → add cache_control to last text part
    if (Array.isArray(content)) {
      for (let i = content.length - 1; i >= 0; i--) {
        const part = content[i];
        if (part?.type === "text") {
          if (typeof part === "object" && !("cache_control" in part)) {
            Object.assign(part, { cache_control: { type: "ephemeral" } });
          }
          return;
        }
      }
    }
    // No patchable text found in this system/developer message; keep scanning.
  }
}
