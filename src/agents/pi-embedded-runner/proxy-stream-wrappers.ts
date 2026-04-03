import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { isXaiModelHint } from "../../../extensions/xai/api.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import { isOpenRouterAnthropicModelRef } from "./anthropic-family-cache-semantics.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
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
      !isOpenRouterAnthropicModelRef(model.provider, model.id)
    ) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      const messages = payloadObj.messages;
      if (Array.isArray(messages)) {
        for (const msg of messages as Array<{ role?: string; content?: unknown }>) {
          if (msg.role === "system" || msg.role === "developer") {
            if (typeof msg.content === "string") {
              msg.content = [
                { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
              ];
            } else if (Array.isArray(msg.content) && msg.content.length > 0) {
              const last = msg.content[msg.content.length - 1];
              if (last && typeof last === "object") {
                const record = last as Record<string, unknown>;
                if (record.type !== "thinking" && record.type !== "redacted_thinking") {
                  record.cache_control = { type: "ephemeral" };
                }
              }
            }
            continue;
          }

          if (msg.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (!block || typeof block !== "object") {
                continue;
              }
              const record = block as Record<string, unknown>;
              if (record.type === "thinking" || record.type === "redacted_thinking") {
                delete record.cache_control;
              }
            }
          }
        }
      }
    });
  };
}

export function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const headers = resolveProviderRequestPolicyConfig({
      provider: typeof model.provider === "string" ? model.provider : "openrouter",
      api: typeof model.api === "string" ? model.api : undefined,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      precedence: "caller-wins",
    }).headers;
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers,
      },
      (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
      },
    );
  };
}

export function isProxyReasoningUnsupported(modelId: string): boolean {
  return isXaiModelHint(modelId);
}

export function createKilocodeWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const headers = resolveProviderRequestPolicyConfig({
      provider: typeof model.provider === "string" ? model.provider : "kilocode",
      api: typeof model.api === "string" ? model.api : undefined,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      providerHeaders: resolveKilocodeAppHeaders(),
      precedence: "defaults-win",
    }).headers;
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers,
      },
      (payload) => {
        normalizeProxyReasoningPayload(payload, thinkingLevel);
      },
    );
  };
}
