import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { normalizeOptionalLowercaseString, readStringValue } from "../../shared/string-coerce.js";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  resolveAnthropicEphemeralCacheControl,
  type AnthropicEphemeralCacheControl,
} from "../anthropic-payload-policy.js";
import { resolveProviderRequestPolicy } from "../provider-attribution.js";
import { resolveProviderRequestPolicyConfig } from "../provider-request-config.js";
import { isAnthropicModelRef } from "./anthropic-family-cache-semantics.js";
import { mapThinkingLevelToReasoningEffort } from "./reasoning-effort-utils.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
}

function readExtraParam(
  extraParams: Record<string, unknown> | undefined,
  keys: readonly string[],
): unknown {
  if (!extraParams) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.hasOwn(extraParams, key)) {
      return extraParams[key];
    }
  }
  return undefined;
}

function resolveBooleanParam(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on", "enable", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disable", "disabled"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function resolveOpenRouterResponseCacheTtlSeconds(value: unknown): string | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return String(Math.max(1, Math.min(86400, Math.trunc(parsed))));
}

function shouldApplyOpenRouterResponseCacheHeaders(model: Parameters<StreamFn>[0]): boolean {
  const provider = readStringValue(model.provider);
  const endpointClass = resolveProviderRequestPolicy({
    provider,
    api: readStringValue(model.api),
    baseUrl: readStringValue(model.baseUrl),
    capability: "llm",
    transport: "stream",
  }).endpointClass;
  return (
    endpointClass === "openrouter" ||
    (endpointClass === "default" && normalizeOptionalLowercaseString(provider) === "openrouter")
  );
}

function resolveOpenRouterResponseCacheHeaders(
  model: Parameters<StreamFn>[0],
  extraParams: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!shouldApplyOpenRouterResponseCacheHeaders(model)) {
    return undefined;
  }
  const configuredCache = resolveBooleanParam(
    readExtraParam(extraParams, ["responseCache", "response_cache"]),
  );
  const clearCache = resolveBooleanParam(
    readExtraParam(extraParams, ["responseCacheClear", "response_cache_clear"]),
  );
  const cacheEnabled = configuredCache ?? (clearCache ? true : undefined);
  if (cacheEnabled === undefined) {
    return undefined;
  }

  const headers: Record<string, string> = {
    "X-OpenRouter-Cache": cacheEnabled ? "true" : "false",
  };
  if (!cacheEnabled) {
    return headers;
  }

  const ttl = resolveOpenRouterResponseCacheTtlSeconds(
    readExtraParam(extraParams, [
      "responseCacheTtlSeconds",
      "response_cache_ttl_seconds",
      "responseCacheTtl",
      "response_cache_ttl",
    ]),
  );
  if (ttl) {
    headers["X-OpenRouter-Cache-TTL"] = ttl;
  }
  if (clearCache) {
    headers["X-OpenRouter-Cache-Clear"] = "true";
  }
  return headers;
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
      reasoningObj.effort = mapThinkingLevelToReasoningEffort(thinkingLevel);
    }
  } else if (!existingReasoning) {
    payloadObj.reasoning = {
      effort: mapThinkingLevelToReasoningEffort(thinkingLevel),
    };
  }
}

/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
export function createOpenRouterSystemCacheWrapper(
  baseStreamFn: StreamFn | undefined,
  extraParams?: Record<string, unknown>,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const provider = readStringValue(model.provider);
    const modelId = readStringValue(model.id);
    // Keep OpenRouter-specific cache markers on verified OpenRouter routes
    // (or the provider's default route), but not on arbitrary OpenAI proxies.
    const endpointClass = resolveProviderRequestPolicy({
      provider,
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
    }).endpointClass;
    const isOpenRouterRoute =
      endpointClass === "openrouter" ||
      (endpointClass === "default" && normalizeOptionalLowercaseString(provider) === "openrouter");
    if (!modelId || !isAnthropicModelRef(modelId) || !isOpenRouterRoute) {
      return underlying(model, context, options);
    }
    // Resolve cacheRetention from extraParams only after confirming this
    // is a verified OpenRouter→Anthropic route. This covers both built-in
    // and custom-provider OpenRouter hosts (endpoint-class based), so
    // explicit cacheRetention on any OpenRouter Anthropic route is honoured.
    // Also support the legacy cacheControlTtl key ("5m" / "1h").
    const explicitRetention = extraParams?.cacheRetention;
    let cacheRetention: "short" | "long" | "none" | undefined =
      explicitRetention === "none" || explicitRetention === "short" || explicitRetention === "long"
        ? explicitRetention
        : undefined;
    if (cacheRetention === undefined) {
      const legacy = extraParams?.cacheControlTtl;
      if (legacy === "5m") {
        cacheRetention = "short";
      } else if (legacy === "1h") {
        cacheRetention = "long";
      }
    }
    // cacheRetention "none" means no new cache markers, but the sanitizer
    // (thinking/redacted_thinking cleanup) must still run.
    const cacheControl: AnthropicEphemeralCacheControl | undefined =
      cacheRetention === "none"
        ? undefined
        : resolveAnthropicEphemeralCacheControl(undefined, cacheRetention);
    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      applyAnthropicEphemeralCacheControlMarkers(
        payloadObj,
        cacheControl ?? { type: "ephemeral" },
        cacheRetention === "none",
      );
    });
  };
}

/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
export function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
  extraParams?: Record<string, unknown>,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const providerHeaders = resolveOpenRouterResponseCacheHeaders(model, extraParams);
    const headers = resolveProviderRequestPolicyConfig({
      provider: readStringValue(model.provider) ?? "openrouter",
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
      callerHeaders: options?.headers,
      providerHeaders,
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

/** @deprecated Proxy provider-owned stream helper; do not use from third-party plugins. */
export function isProxyReasoningUnsupported(modelId: string): boolean {
  const trimmed = normalizeOptionalLowercaseString(modelId);
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 && trimmed?.slice(0, slashIndex) === "x-ai";
}

/** @deprecated Kilocode provider-owned stream helper; do not use from third-party plugins. */
export function createKilocodeWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const headers = resolveProviderRequestPolicyConfig({
      provider: readStringValue(model.provider) ?? "kilocode",
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
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
