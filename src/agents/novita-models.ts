import type { ModelDefinitionConfig } from "../config/types.models.js";

export const NOVITA_BASE_URL = "https://api.novita.ai/openai";
export const NOVITA_DEFAULT_MODEL_ID = "moonshotai/kimi-k2.5";
export const NOVITA_DEFAULT_MODEL_REF = `novita/${NOVITA_DEFAULT_MODEL_ID}`;

export const NOVITA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const NOVITA_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: NOVITA_DEFAULT_MODEL_ID,
    name: "Kimi K2.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 262144,
    cost: NOVITA_DEFAULT_COST,
  },
];

type NovitaModel = {
  id?: string;
  name?: string;
  title?: string;
  display_name?: string;
  context_size?: number;
  max_output_tokens?: number;
  input_token_price_per_m?: number;
  output_token_price_per_m?: number;
  model_type?: string;
  features?: string[];
};

type NovitaModelsResponse = {
  data?: NovitaModel[];
};

const NOVITA_DISCOVERY_TIMEOUT_MS = 7000;
const NOVITA_DISCOVERY_CACHE_MS = 5 * 60 * 1000;

const novitaDiscoveryCache = new Map<
  string,
  {
    expiresAt: number;
    models: ModelDefinitionConfig[];
  }
>();

export function buildNovitaModelDefinition(
  model: (typeof NOVITA_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    api: "openai-completions",
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export function resetNovitaDiscoveryCacheForTest(): void {
  novitaDiscoveryCache.clear();
}

function normalizeModelId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeFeatureList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function fallbackNovitaModels(): ModelDefinitionConfig[] {
  return NOVITA_MODEL_CATALOG.map(buildNovitaModelDefinition);
}

function inferReasoning(id: string): boolean {
  const normalized = id.toLowerCase();
  return (
    normalized.includes("reason") ||
    normalized.includes("thinking") ||
    normalized.includes("-r1") ||
    normalized.endsWith("/r1")
  );
}

function inferImageSupport(params: { modelType: string; features: string[]; id: string }): boolean {
  const { modelType, features, id } = params;
  if (modelType.includes("vision") || modelType.includes("multimodal")) {
    return true;
  }
  if (
    features.some((feature) =>
      ["vision", "image", "image_input", "multimodal"].some((token) => feature.includes(token)),
    )
  ) {
    return true;
  }
  const normalizedId = id.toLowerCase();
  return normalizedId.includes("vl") || normalizedId.includes("vision");
}

export async function discoverNovitaModels(params: {
  apiKey: string;
  useCache?: boolean;
}): Promise<ModelDefinitionConfig[]> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return fallbackNovitaModels();
  }

  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    return fallbackNovitaModels();
  }

  const useCache = params.useCache ?? true;
  const cached = novitaDiscoveryCache.get(apiKey);
  if (useCache && cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  try {
    const response = await fetch(`${NOVITA_BASE_URL}/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(NOVITA_DISCOVERY_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(
        `[novita-models] Failed to discover models: HTTP ${response.status}, using static catalog`,
      );
      return fallbackNovitaModels();
    }

    const payload = (await response.json()) as NovitaModelsResponse;
    const apiModels = Array.isArray(payload.data) ? payload.data : [];
    if (apiModels.length === 0) {
      console.warn("[novita-models] No models returned from API, using static catalog");
      return fallbackNovitaModels();
    }

    const catalogById = new Map(
      NOVITA_MODEL_CATALOG.map((entry) => [entry.id.toLowerCase(), entry] as const),
    );
    const deduped = new Set<string>();
    const resolved: ModelDefinitionConfig[] = [];

    for (const model of apiModels) {
      const id = normalizeModelId(model?.id);
      if (!id) {
        continue;
      }
      const dedupeKey = id.toLowerCase();
      if (deduped.has(dedupeKey)) {
        continue;
      }
      deduped.add(dedupeKey);

      const name = normalizeModelId(model?.name) || id;
      const displayName = normalizeModelId(model?.display_name);
      const title = normalizeModelId(model?.title);
      const resolvedName = displayName || title || name;
      const features = normalizeFeatureList(model?.features);
      const modelType = normalizeModelId(model?.model_type).toLowerCase();
      const hasImageInput = inferImageSupport({ modelType, features, id });
      const contextWindow = normalizePositiveNumber(model?.context_size) ?? 128000;
      const maxTokens = normalizePositiveNumber(model?.max_output_tokens) ?? 8192;
      const inputCost = normalizeNonNegativeNumber(model?.input_token_price_per_m) ?? 0;
      const outputCost = normalizeNonNegativeNumber(model?.output_token_price_per_m) ?? 0;
      const inferredReasoning = inferReasoning(id);

      const catalogEntry = catalogById.get(dedupeKey);
      if (catalogEntry) {
        const base = buildNovitaModelDefinition(catalogEntry);
        resolved.push({
          ...base,
          name: resolvedName || base.name,
          reasoning: base.reasoning || inferredReasoning,
          input: hasImageInput ? ["text", "image"] : base.input,
          cost: {
            input: inputCost || base.cost.input,
            output: outputCost || base.cost.output,
            cacheRead: base.cost.cacheRead,
            cacheWrite: base.cost.cacheWrite,
          },
          contextWindow: normalizePositiveNumber(model?.context_size) ?? base.contextWindow,
          maxTokens: normalizePositiveNumber(model?.max_output_tokens) ?? base.maxTokens,
        });
        continue;
      }

      resolved.push({
        id,
        name: resolvedName,
        api: "openai-completions",
        reasoning: inferredReasoning,
        input: hasImageInput ? ["text", "image"] : ["text"],
        cost: {
          input: inputCost,
          output: outputCost,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow,
        maxTokens,
      });
    }

    const models = resolved.length > 0 ? resolved : fallbackNovitaModels();
    if (useCache) {
      novitaDiscoveryCache.set(apiKey, {
        expiresAt: Date.now() + NOVITA_DISCOVERY_CACHE_MS,
        models,
      });
    }
    return models;
  } catch (error) {
    console.warn(`[novita-models] Discovery failed: ${String(error)}, using static catalog`);
    return fallbackNovitaModels();
  }
}
