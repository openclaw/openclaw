import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelCompatConfig,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asNonArrayRecord,
  asOptionalRecord,
  asPositiveSafeInteger,
  filterStringEntries,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const BASETEN_MANIFEST_CATALOG = manifest.modelCatalog.providers.baseten;
const BASETEN_MODEL_COMPAT = new Map(
  buildManifestModelProviderConfig({
    providerId: "baseten",
    catalog: BASETEN_MANIFEST_CATALOG,
  }).models.map(({ id, compat }) => [id, compat]),
);
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

const CHAT_TEMPLATE_THINKING_MODEL_IDS = new Set([
  "zai-org/glm-4.7",
  "zai-org/glm-5.2",
  "zai-org/glm-5.2-fast",
  "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.7-code",
  "nvidia/nvidia-nemotron-3-ultra-550b-a55b",
]);

const BASE_COMPAT: ModelCompatConfig = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: true,
  supportsTools: true,
  maxTokensField: "max_tokens",
};

export const BASETEN_BASE_URL = BASETEN_MANIFEST_CATALOG.baseUrl;
export const BASETEN_DEFAULT_MODEL_ID = BASETEN_MANIFEST_CATALOG.defaultModel;
export const BASETEN_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "baseten")!;
export const BASETEN_MODEL_CATALOG = BASETEN_MANIFEST_CATALOG.models;

export function usesBasetenChatTemplateThinking(modelId: string): boolean {
  return CHAT_TEMPLATE_THINKING_MODEL_IDS.has(modelId.trim().toLowerCase());
}

export function buildBasetenModelCompat(modelId: string): ModelCompatConfig {
  return {
    ...BASE_COMPAT,
    ...structuredClone(BASETEN_MODEL_COMPAT.get(modelId)),
  };
}

export function buildStaticBasetenModels(): ModelDefinitionConfig[] {
  return buildManifestModelProviderConfig({
    providerId: "baseten",
    catalog: BASETEN_MANIFEST_CATALOG,
  }).models.map((model) => Object.assign(model, { compat: buildBasetenModelCompat(model.id) }));
}

function readPerTokenPrice(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0
    ? Number((number * 1_000_000).toFixed(9))
    : undefined;
}

function applyLiveReasoningEffortCompat(
  fallbackCompat: ModelCompatConfig,
  supportsReasoningEffort: boolean,
): ModelCompatConfig {
  if (supportsReasoningEffort) {
    return { ...fallbackCompat, supportsReasoningEffort: true };
  }
  const compat = { ...fallbackCompat };
  delete compat.supportsReasoningEffort;
  delete compat.supportedReasoningEfforts;
  delete compat.reasoningEffortMap;
  return compat;
}

function projectLiveModel(
  row: Record<string, unknown>,
  fallback: ModelDefinitionConfig | undefined,
): ModelDefinitionConfig | undefined {
  if (row.object !== undefined && row.object !== "model") {
    return undefined;
  }
  const id = normalizeOptionalString(row.id);
  if (!id) {
    return undefined;
  }

  const hasLiveFeatures = Array.isArray(row.supported_features);
  const features = new Set(filterStringEntries(row.supported_features));
  const pricing = asNonArrayRecord(row.pricing);
  const inputPrice = readPerTokenPrice(pricing.prompt);
  const outputPrice = readPerTokenPrice(pricing.completion);
  const cacheReadPrice = readPerTokenPrice(pricing.input_cache_read);
  // These current DeepSeek rows omit feature flags documented by Baseten's serving API.
  const hasDocumentedSparseFeatures =
    ["deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-ai/DeepSeek-V4-Pro-0813"].includes(id) &&
    ["tools", "reasoning", "json_mode", "structured_outputs"].every((feature) =>
      features.has(feature),
    );
  const fallbackCompat = fallback?.compat ?? buildBasetenModelCompat(id);
  const supportsReasoningEffort =
    features.has("reasoning_effort") ||
    (hasDocumentedSparseFeatures && fallbackCompat.supportsReasoningEffort === true);
  const compat = hasLiveFeatures
    ? applyLiveReasoningEffortCompat(fallbackCompat, supportsReasoningEffort)
    : fallbackCompat;

  return {
    id,
    name: normalizeOptionalString(row.name) ?? fallback?.name ?? id,
    reasoning: hasLiveFeatures
      ? features.has("reasoning") || supportsReasoningEffort
      : (fallback?.reasoning ?? false),
    input: hasLiveFeatures
      ? features.has("vision") || (hasDocumentedSparseFeatures && fallback?.input.includes("image"))
        ? ["text", "image"]
        : ["text"]
      : (fallback?.input ?? ["text"]),
    cost: {
      input: inputPrice ?? fallback?.cost.input ?? 0,
      output: outputPrice ?? fallback?.cost.output ?? 0,
      cacheRead: cacheReadPrice ?? fallback?.cost.cacheRead ?? 0,
      cacheWrite: fallback?.cost.cacheWrite ?? 0,
    },
    contextWindow:
      asPositiveSafeInteger(Number(row.context_length)) ??
      fallback?.contextWindow ??
      DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      asPositiveSafeInteger(Number(row.max_completion_tokens)) ??
      fallback?.maxTokens ??
      DEFAULT_MAX_TOKENS,
    compat,
  };
}

/** Projects Baseten's authenticated `/models` response into OpenClaw model rows. */
export function projectBasetenLiveModels(rows: readonly unknown[]): ModelDefinitionConfig[] {
  const fallbacks = new Map(buildStaticBasetenModels().map((model) => [model.id, model]));
  const seen = new Set<string>();
  const models: ModelDefinitionConfig[] = [];
  for (const value of rows) {
    const row = asOptionalRecord(value);
    if (!row) {
      continue;
    }
    const model = projectLiveModel(row, fallbacks.get(String(row.id)));
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/** Resolves a forward-compatible Baseten model id not yet in the bundled catalog. */
export function resolveBasetenDynamicModel(modelId: string) {
  const id = modelId.trim();
  if (!id || BASETEN_MODEL_CATALOG.some((model) => model.id === id)) {
    return undefined;
  }
  return {
    id,
    name: id,
    provider: "baseten",
    api: "openai-completions" as const,
    baseUrl: BASETEN_BASE_URL,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: buildBasetenModelCompat(id),
  };
}
