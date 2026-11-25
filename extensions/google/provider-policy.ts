import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/core";
import type {
  ModelProviderConfig,
  ProviderFastModePolicyContext,
} from "openclaw/plugin-sdk/provider-model-types";
import {
  isGoogleGemini3ProModel,
  isGoogleGemini3ThinkingLevelModel,
} from "openclaw/plugin-sdk/provider-thinking-runtime";
import {
  normalizeFastMode,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeAntigravityModelId, normalizeGoogleModelId } from "./model-id.js";
import { isGoogleGeminiTextModelId } from "./provider-models.js";
import {
  isGoogleGenerativeAiApi,
  isGoogleVertexBaseUrl,
  isOfficialGoogleAiStudioBaseUrl,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
} from "./src/google-api-base-url.js";

export {
  DEFAULT_GOOGLE_API_BASE_URL,
  isGoogleGenerativeAiApi,
  isOfficialGoogleAiStudioBaseUrl,
  isGoogleVertexBaseUrl,
  isGoogleVertexHostname,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
} from "./src/google-api-base-url.js";

type GoogleApiCarrier = {
  api?: string | null;
};

type GoogleProviderConfigLike = GoogleApiCarrier & {
  baseUrl?: string | null;
  models?: ReadonlyArray<GoogleApiCarrier | null | undefined> | null;
};

const GOOGLE_MODEL_ID_PROVIDERS = new Set(["google", "google-gemini-cli", "google-vertex"]);

export function resolveGoogleGenerativeAiTransport<TApi extends string | null | undefined>(params: {
  provider?: string;
  api: TApi;
  baseUrl?: string;
}): { api: TApi | "google-generative-ai" | "google-vertex"; baseUrl?: string } {
  const api =
    params.api ??
    (params.provider === "google-vertex" && isGoogleVertexBaseUrl(params.baseUrl)
      ? "google-vertex"
      : undefined) ??
    (params.provider === "google" && params.baseUrl ? "google-generative-ai" : params.api);
  return {
    api,
    baseUrl: isGoogleGenerativeAiApi(api)
      ? normalizeGoogleGenerativeAiBaseUrl(params.baseUrl)
      : params.baseUrl,
  };
}

export function resolveGoogleGenerativeAiApiOrigin(baseUrl?: string): string {
  return (
    normalizeGoogleGenerativeAiBaseUrl(baseUrl) ?? normalizeGoogleApiBaseUrl(baseUrl)
  ).replace(/\/v1beta$/i, "");
}

export function shouldNormalizeGoogleGenerativeAiProviderConfig(
  providerKey: string,
  provider: GoogleProviderConfigLike,
): boolean {
  if (providerKey === "google-vertex" && isGoogleVertexBaseUrl(provider.baseUrl)) {
    return false;
  }
  if (isGoogleGenerativeAiApi(provider.api)) {
    return true;
  }
  const hasGoogleGenerativeAiModelApi =
    provider.models?.some((model) => isGoogleGenerativeAiApi(model?.api)) ?? false;
  if (hasGoogleGenerativeAiModelApi) {
    return true;
  }
  if (providerKey !== "google" && providerKey !== "google-vertex") {
    return false;
  }
  const hasExplicitNonGoogleApi = normalizeOptionalString(provider.api) !== undefined;
  return !hasExplicitNonGoogleApi;
}

export function shouldNormalizeGoogleProviderConfig(
  providerKey: string,
  provider: GoogleProviderConfigLike,
): boolean {
  return (
    providerKey === "google-antigravity" ||
    shouldNormalizeGoogleGenerativeAiProviderConfig(providerKey, provider)
  );
}

function normalizeProviderModels(
  provider: ModelProviderConfig,
  normalizeId: (id: string) => string,
): ModelProviderConfig {
  const models = provider.models;
  if (!models?.length) {
    return provider;
  }

  let mutated = false;
  const nextModels = models.map((model) => {
    const nextId = normalizeId(model.id);
    if (nextId === model.id) {
      return model;
    }
    mutated = true;
    return Object.assign({}, model, { id: nextId });
  });

  return mutated ? { ...provider, models: nextModels } : provider;
}

export function normalizeGoogleProviderConfig(
  providerKey: string,
  provider: ModelProviderConfig,
): ModelProviderConfig {
  if (providerKey === "google-antigravity") {
    return normalizeProviderModels(provider, normalizeAntigravityModelId);
  }
  if (!GOOGLE_MODEL_ID_PROVIDERS.has(providerKey)) {
    return provider;
  }
  const normalized = normalizeProviderModels(provider, normalizeGoogleModelId);
  if (!shouldNormalizeGoogleGenerativeAiProviderConfig(providerKey, normalized)) {
    return normalized;
  }
  const baseUrl = normalizeGoogleGenerativeAiBaseUrl(normalized.baseUrl);
  return baseUrl !== normalized.baseUrl
    ? { ...normalized, baseUrl: baseUrl ?? normalized.baseUrl }
    : normalized;
}

export function resolveGoogleThinkingProfile({
  modelId,
  reasoning,
}: ProviderDefaultThinkingPolicyContext): ProviderThinkingProfile | undefined {
  const normalizedModelId = normalizeGoogleModelId(modelId);
  const isGemini3ThinkingModel = isGoogleGemini3ThinkingLevelModel(normalizedModelId);
  if (reasoning === false && !isGemini3ThinkingModel) {
    return undefined;
  }

  // Gemini 3.1 Pro has no MINIMAL thinking level.
  const levels: ProviderThinkingProfile["levels"] = [
    { id: "off" },
    ...(isGoogleGemini3ProModel(normalizedModelId) ? [] : [{ id: "minimal" as const }]),
    { id: "low" },
    { id: "medium" },
    { id: "adaptive" },
    { id: "high" },
  ];

  return {
    levels,
    ...(isGemini3ThinkingModel ? { preserveWhenCatalogReasoningFalse: true } : {}),
  };
}

export type GoogleServiceTier = "standard" | "flex" | "priority";

function normalizeGoogleServiceTier(value: unknown): GoogleServiceTier | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "standard" || normalized === "flex" || normalized === "priority"
    ? normalized
    : undefined;
}

export function resolveGoogleServiceTier(
  extraParams?: Record<string, unknown>,
): GoogleServiceTier | undefined {
  const explicitTier = normalizeGoogleServiceTier(
    extraParams?.serviceTier ?? extraParams?.service_tier,
  );
  if (explicitTier) {
    return explicitTier;
  }
  const rawFastMode = extraParams?.fastMode ?? extraParams?.fast_mode;
  const resolvedFastMode = normalizeFastMode(
    // SAFETY: the runtime passes per-request Fast mode as a zero-argument resolver.
    typeof rawFastMode === "function" ? (rawFastMode as () => unknown)() : rawFastMode,
  );
  return resolvedFastMode === true || resolvedFastMode === "ultrafast" ? "priority" : undefined;
}

export function resolveGoogleFastModeSupport(
  ctx: ProviderFastModePolicyContext,
): boolean | undefined {
  if (ctx.runtimeId !== undefined && ctx.runtimeId !== "auto" && ctx.runtimeId !== "openclaw") {
    return false;
  }
  if (normalizeLowercaseStringOrEmpty(ctx.provider) !== "google") {
    return false;
  }
  if (!ctx.api) {
    return undefined;
  }
  const isInteractionsRoute =
    ctx.api === "google-interactions" ||
    (ctx.api === "google-generative-ai" &&
      isOfficialGoogleAiStudioBaseUrl(ctx.baseUrl) &&
      isGoogleGeminiTextModelId(ctx.modelId));
  if (!isInteractionsRoute || isGoogleVertexBaseUrl(ctx.baseUrl)) {
    return false;
  }
  if (normalizeGoogleServiceTier(ctx.params?.serviceTier ?? ctx.params?.service_tier)) {
    return false;
  }
  return true;
}
