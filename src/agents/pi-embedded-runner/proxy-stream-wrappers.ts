import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { isProxyReasoningUnsupportedModelHint } from "../../plugin-sdk/provider-model-shared.js";
import { resolveProviderRequestPolicy } from "../provider-attribution.js";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import { applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-cache-control-payload.js";
import { isAnthropicModelRef } from "./anthropic-family-cache-semantics.js";
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
    const provider = typeof model.provider === "string" ? model.provider : undefined;
    const modelId = typeof model.id === "string" ? model.id : undefined;
    // Keep OpenRouter-specific cache markers on verified OpenRouter routes
    // (or the provider's default route), but not on arbitrary OpenAI proxies.
    const endpointClass = resolveProviderRequestPolicy({
      provider,
      api: typeof model.api === "string" ? model.api : undefined,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      capability: "llm",
      transport: "stream",
    }).endpointClass;
    if (
      !modelId ||
      !isAnthropicModelRef(modelId) ||
      !(
        endpointClass === "openrouter" ||
        (endpointClass === "default" && provider?.trim().toLowerCase() === "openrouter")
      )
    ) {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      applyAnthropicEphemeralCacheControlMarkers(payloadObj);
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
  return isProxyReasoningUnsupportedModelHint(modelId);
}

// Some OpenAI-compatible endpoints (e.g. ZenMux proxying DeepSeek thinking
// models) emit reasoning via the `reasoning` field in streaming responses but
// require the assistant history to be sent back with `reasoning_content`. Pi-ai's
// convertMessages preserves the source field name, which yields a mismatch and
// surfaces as "The reasoning_content in the thinking mode must be passed back
// to the API". Rename `reasoning` -> `reasoning_content` on assistant messages
// for openai-completions calls outside OpenRouter routes.
export function createReasoningContentNormalizerWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.api !== "openai-completions") {
      return underlying(model, context, options);
    }
    const provider = typeof model.provider === "string" ? model.provider : undefined;
    const endpointClass = resolveProviderRequestPolicy({
      provider,
      api: typeof model.api === "string" ? model.api : undefined,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      capability: "llm",
      transport: "stream",
    }).endpointClass;
    const isOpenRouterLike =
      endpointClass === "openrouter" ||
      (endpointClass === "default" && provider?.trim().toLowerCase() === "openrouter");
    if (isOpenRouterLike) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      const messages = (payload as { messages?: unknown }).messages;
      if (!Array.isArray(messages)) {
        return;
      }
      for (const msg of messages) {
        if (
          msg &&
          typeof msg === "object" &&
          (msg as { role?: unknown }).role === "assistant" &&
          typeof (msg as { reasoning?: unknown }).reasoning === "string" &&
          (msg as { reasoning_content?: unknown }).reasoning_content === undefined
        ) {
          const target = msg as Record<string, unknown>;
          target.reasoning_content = target.reasoning;
          delete target.reasoning;
        }
      }
    });
  };
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
