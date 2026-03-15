import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";

const OPENROUTER_APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
};
const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
}

function isOpenRouterAnthropicModel(provider: string, modelId: string): boolean {
  return provider.toLowerCase() === "openrouter" && modelId.toLowerCase().startsWith("anthropic/");
}

function mapThinkingLevelToOpenRouterReasoningEffort(
  thinkingLevel: ThinkLevel,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  if (thinkingLevel === "off") {
    return "none";
  }
  if (thinkingLevel === "adaptive") {
    return "medium";
  }
  return thinkingLevel;
}

function normalizeProxyReasoningPayload(payload: unknown, thinkingLevel?: ThinkLevel): void {
  if (!payload || typeof payload !== "object") {
    return;
  }

  const payloadObj = payload as Record<string, unknown>;
  delete payloadObj.reasoning_effort;
  if (!thinkingLevel || thinkingLevel === "off") {
    return;
  }

  const existingReasoning = payloadObj.reasoning;
  if (
    existingReasoning &&
    typeof existingReasoning === "object" &&
    !Array.isArray(existingReasoning)
  ) {
    const reasoningObj = existingReasoning as Record<string, unknown>;
    if (!("max_tokens" in reasoningObj) && !("effort" in reasoningObj)) {
      reasoningObj.effort = mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel);
    }
  } else if (!existingReasoning) {
    payloadObj.reasoning = {
      effort: mapThinkingLevelToOpenRouterReasoningEffort(thinkingLevel),
    };
  }
}

export function createOpenRouterSystemCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (
      typeof model.provider !== "string" ||
      typeof model.id !== "string" ||
      !isOpenRouterAnthropicModel(model.provider, model.id)
    ) {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        const messages = (payload as Record<string, unknown>)?.messages;
        if (Array.isArray(messages)) {
          for (const msg of messages as Array<{ role?: string; content?: unknown }>) {
            if (msg.role !== "system" && msg.role !== "developer") {
              continue;
            }
            if (typeof msg.content === "string") {
              msg.content = [
                { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
              ];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
              const last = msg.content[msg.content.length - 1];
              if (last && typeof last === "object") {
                (last as Record<string, unknown>).cache_control = { type: "ephemeral" };
              }
            }
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

export function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      headers: {
        ...OPENROUTER_APP_HEADERS,
        ...options?.headers,
      },
      onPayload: (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
        return onPayload?.(payload, model);
      },
    });
  };
}

export function isProxyReasoningUnsupported(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("x-ai/");
}

/**
 * Normalize `reasoning_effort` for Groq's API.
 *
 * Groq only accepts `"none"` or `"default"` for the top-level
 * `reasoning_effort` field.  Any other value (e.g. "low", "medium", "high")
 * causes an HTTP 400.  This helper clamps the value accordingly and also
 * strips the nested `reasoning.effort` object that the generic proxy
 * normalizer would inject.
 *
 * @see https://github.com/openclaw/openclaw/issues/32638
 */
function normalizeGroqReasoningPayload(payload: unknown, thinkingLevel?: ThinkLevel): void {
  if (!payload || typeof payload !== "object") {
    return;
  }

  const payloadObj = payload as Record<string, unknown>;

  // Remove nested reasoning.effort — Groq uses top-level reasoning_effort only.
  delete payloadObj.reasoning;

  if (!thinkingLevel || thinkingLevel === "off") {
    // When thinking is off, send "none" so reasoning is explicitly disabled.
    payloadObj.reasoning_effort = "none";
    return;
  }

  // Any non-"none" value must be sent as "default" for Groq.
  const current = payloadObj.reasoning_effort;
  payloadObj.reasoning_effort = current === "none" ? "none" : "default";
}

export function createGroqWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        normalizeGroqReasoningPayload(payload, thinkingLevel);
        return onPayload?.(payload, model);
      },
    });
  };
}

export function createKilocodeWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        ...resolveKilocodeAppHeaders(),
      },
      onPayload: (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
        return onPayload?.(payload, model);
      },
    });
  };
}
