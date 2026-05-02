import type {
  ModelCompatConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-types";

export const ARCEE_BASE_URL = "https://api.arcee.ai/api/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const ARCEE_TRINITY_LARGE_THINKING_COMPAT = {
  supportsReasoningEffort: false,
  supportsTools: false,
} as const satisfies ModelCompatConfig;

const ARCEE_PROVIDER_ID = "arcee";
const OPENROUTER_LEGACY_BASE_URL = "https://openrouter.ai/v1";
const ARCEE_TRINITY_LARGE_THINKING_ID = "trinity-large-thinking";
const ARCEE_TRINITY_LARGE_THINKING_REF = `${ARCEE_PROVIDER_ID}/${ARCEE_TRINITY_LARGE_THINKING_ID}`;

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase();
}

function normalizeBaseUrl(baseUrl: unknown): string {
  return typeof baseUrl === "string" ? baseUrl.trim().replace(/\/+$/, "") : "";
}

export function normalizeArceeOpenRouterBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === OPENROUTER_BASE_URL || normalized === OPENROUTER_LEGACY_BASE_URL) {
    return OPENROUTER_BASE_URL;
  }
  return undefined;
}

export function toArceeOpenRouterModelId(modelId: string): string {
  const normalized = modelId.trim();
  if (!normalized || normalized.startsWith("arcee/")) {
    return normalized;
  }
  return `arcee/${normalized}`;
}

export function isArceeTrinityLargeThinkingModelId(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return (
    normalized === ARCEE_TRINITY_LARGE_THINKING_ID ||
    normalized === ARCEE_TRINITY_LARGE_THINKING_REF
  );
}

export function shouldContributeArceeTrinityLargeThinkingCompat(params: {
  provider?: unknown;
  modelId: string;
  model: { id: string; provider?: unknown; baseUrl?: unknown };
}): boolean {
  const modelId = normalizeModelId(params.modelId);
  const resolvedId = normalizeModelId(params.model.id);
  if (
    modelId === ARCEE_TRINITY_LARGE_THINKING_REF ||
    resolvedId === ARCEE_TRINITY_LARGE_THINKING_REF
  ) {
    return true;
  }
  if (
    modelId !== ARCEE_TRINITY_LARGE_THINKING_ID &&
    resolvedId !== ARCEE_TRINITY_LARGE_THINKING_ID
  ) {
    return false;
  }
  if (params.provider === ARCEE_PROVIDER_ID || params.model.provider === ARCEE_PROVIDER_ID) {
    return true;
  }
  return normalizeBaseUrl(params.model.baseUrl) === normalizeBaseUrl(ARCEE_BASE_URL);
}

export function applyArceeTrinityLargeThinkingCompat<T extends { id: string; compat?: unknown }>(
  model: T,
): T {
  if (!isArceeTrinityLargeThinkingModelId(model.id)) {
    return model;
  }
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : undefined;
  if (
    compat?.supportsReasoningEffort ===
      ARCEE_TRINITY_LARGE_THINKING_COMPAT.supportsReasoningEffort &&
    compat?.supportsTools === ARCEE_TRINITY_LARGE_THINKING_COMPAT.supportsTools
  ) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...compat,
      ...ARCEE_TRINITY_LARGE_THINKING_COMPAT,
    } as T extends { compat?: infer TCompat } ? TCompat : never,
  } as T;
}

export function normalizeArceeProviderConfig(
  providerConfig: ModelProviderConfig,
): ModelProviderConfig {
  let changed = false;
  const normalizedBaseUrl = normalizeArceeOpenRouterBaseUrl(providerConfig.baseUrl);
  const baseUrl =
    normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
      ? normalizedBaseUrl
      : providerConfig.baseUrl;
  if (baseUrl !== providerConfig.baseUrl) {
    changed = true;
  }

  const hasModels = Array.isArray(providerConfig.models);
  const models = hasModels
    ? providerConfig.models.map((model) => {
        const normalizedModel = applyArceeTrinityLargeThinkingCompat(model);
        if (normalizedModel === model) {
          return model;
        }
        changed = true;
        return normalizedModel;
      })
    : providerConfig.models;

  return changed
    ? { ...providerConfig, baseUrl, ...(hasModels ? { models } : {}) }
    : providerConfig;
}
