import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

export const EDENAI_BASE_URL = "https://api.edenai.run/v3";
const EDENAI_LEGACY_BASE_URLS: ReadonlySet<string> = new Set([
  "https://api.edenai.run/v2/llm",
  "https://api.edenai.run/v2",
]);
const EDENAI_DEFAULT_CONTEXT_WINDOW = 200_000;
const EDENAI_DEFAULT_MAX_TOKENS = 8_192;
const EDENAI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const log = createSubsystemLogger("agents/edenai");

type EdenAiPricingShape = {
  input_cost_per_token?: number | string;
  output_cost_per_token?: number | string;
  cache_read_input_token_cost?: number | string;
  cache_creation_input_token_cost?: number | string;
};

type EdenAiCapabilitiesShape = {
  input_modalities?: string[];
  output_modalities?: string[];
  supports_reasoning?: boolean;
  supports_function_calling?: boolean;
};

type EdenAiModelShape = {
  id?: string;
  model_name?: string;
  owned_by?: string;
  context_length?: number;
  description?: string;
  capabilities?: EdenAiCapabilitiesShape;
  pricing?: EdenAiPricingShape;
};

type EdenAiModelsResponse = {
  data?: EdenAiModelShape[];
};

type StaticEdenAiModel = Omit<ModelDefinitionConfig, "cost"> & {
  cost?: Partial<ModelDefinitionConfig["cost"]>;
};

// Curated offline fallback shown by `openclaw models list --all` when no
// EDENAI_API_KEY is resolved. Once auth resolves, the live `/v3/models`
// catalog (500+ entries) supersedes this list, including each model's
// live pricing returned by Eden AI itself.
//
// The cost / contextWindow / maxTokens numbers below are a snapshot at
// release time. They control OpenClaw's offline display only -- Eden AI's
// own pricing applies to actual API calls, and live discovery overrides
// these fields whenever the user has authenticated. Refresh when a major
// model generation lands (one PR per cycle, same cadence as vercel-ai-
// gateway and openrouter bundled plugins).
//
// Anthropic models on Eden AI use the hyphen id form (claude-opus-4-7), not
// the dot form Anthropic's own catalog uses (claude-opus-4.7); Eden AI
// returns HTTP 400 on the dot form.
const STATIC_EDENAI_MODEL_CATALOG: readonly StaticEdenAiModel[] = [
  {
    id: "anthropic/claude-opus-4-7",
    name: "Anthropic: Claude Opus 4.7",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Anthropic: Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Anthropic: Claude Haiku 4.5",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 8_192,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  {
    id: "openai/gpt-5.5",
    name: "OpenAI: GPT-5.5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 2.5, output: 10, cacheRead: 0.25 },
  },
  {
    id: "openai/gpt-4o-mini",
    name: "OpenAI: GPT-4o mini",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0.15, output: 0.6, cacheRead: 0.075 },
  },
  {
    id: "google/gemini-3.5-flash",
    name: "Google: Gemini 3.5 Flash",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    cost: { input: 0.3, output: 2.5, cacheRead: 0.075 },
  },
  {
    id: "google/gemini-2.5-flash-lite",
    name: "Google: Gemini 2.5 Flash Lite",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 8_192,
    cost: EDENAI_DEFAULT_COST,
  },
  {
    id: "mistral/mistral-large-latest",
    name: "Mistral: Large",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 2, output: 6 },
  },
] as const;

function toPerMillionCost(value: number | string | undefined): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return numeric * 1_000_000;
}

function normalizeCost(pricing?: EdenAiPricingShape): ModelDefinitionConfig["cost"] {
  return {
    input: toPerMillionCost(pricing?.input_cost_per_token),
    output: toPerMillionCost(pricing?.output_cost_per_token),
    cacheRead: toPerMillionCost(pricing?.cache_read_input_token_cost),
    cacheWrite: toPerMillionCost(pricing?.cache_creation_input_token_cost),
  };
}

function buildStaticModelDefinition(model: StaticEdenAiModel): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: {
      ...EDENAI_DEFAULT_COST,
      ...model.cost,
    },
  };
}

function getStaticFallbackModel(id: string): ModelDefinitionConfig | undefined {
  const fallback = STATIC_EDENAI_MODEL_CATALOG.find((entry) => entry.id === id);
  return fallback ? buildStaticModelDefinition(fallback) : undefined;
}

export function getStaticEdenaiModelCatalog(): ModelDefinitionConfig[] {
  return STATIC_EDENAI_MODEL_CATALOG.map(buildStaticModelDefinition);
}

function buildDiscoveredModelDefinition(model: EdenAiModelShape): ModelDefinitionConfig | null {
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) {
    return null;
  }

  const fallback = getStaticFallbackModel(id);
  const contextWindow =
    typeof model.context_length === "number" && Number.isFinite(model.context_length)
      ? model.context_length
      : (fallback?.contextWindow ?? EDENAI_DEFAULT_CONTEXT_WINDOW);
  const maxTokens = fallback?.maxTokens ?? EDENAI_DEFAULT_MAX_TOKENS;
  const normalizedCost = normalizeCost(model.pricing);
  const hasLiveCost =
    normalizedCost.input > 0 ||
    normalizedCost.output > 0 ||
    normalizedCost.cacheRead > 0 ||
    normalizedCost.cacheWrite > 0;

  const supportsImage =
    Array.isArray(model.capabilities?.input_modalities) &&
    model.capabilities.input_modalities.includes("image");
  const input: ModelDefinitionConfig["input"] = supportsImage
    ? ["text", "image"]
    : (fallback?.input ?? ["text"]);

  const reasoning =
    typeof model.capabilities?.supports_reasoning === "boolean"
      ? model.capabilities.supports_reasoning
      : (fallback?.reasoning ?? false);

  const name =
    (typeof model.model_name === "string" ? model.model_name.trim() : "") || fallback?.name || id;

  return {
    id,
    name,
    reasoning,
    input,
    contextWindow,
    maxTokens,
    cost: hasLiveCost ? normalizedCost : (fallback?.cost ?? { ...EDENAI_DEFAULT_COST }),
  };
}

// Capability cache populated by prepareDynamicModel(). When OpenClaw resolves
// an arbitrary model id (`resolveDynamicModel`), it can pull the real catalog
// metadata from here instead of falling back to generic defaults. The cache
// is filled in-process and shared across all dynamic-model resolutions.
let liveCatalogCache: Map<string, ModelDefinitionConfig> | null = null;
let pendingLiveCatalogLoad: Promise<void> | null = null;

async function refreshLiveCatalogCache(): Promise<void> {
  const discovered = await discoverEdenaiModels();
  liveCatalogCache = new Map(discovered.map((model) => [model.id, model]));
}

export async function loadEdenaiModelCapabilities(_modelId: string): Promise<void> {
  if (liveCatalogCache) {
    return;
  }
  if (!pendingLiveCatalogLoad) {
    pendingLiveCatalogLoad = refreshLiveCatalogCache().finally(() => {
      pendingLiveCatalogLoad = null;
    });
  }
  await pendingLiveCatalogLoad;
}

export function getEdenaiModelCapabilities(modelId: string): ModelDefinitionConfig | undefined {
  return liveCatalogCache?.get(modelId);
}

export async function discoverEdenaiModels(): Promise<ModelDefinitionConfig[]> {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return getStaticEdenaiModelCatalog();
  }

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${EDENAI_BASE_URL}/models`,
      timeoutMs: 5000,
      auditContext: "edenai.models",
    });
    try {
      if (!response.ok) {
        log.warn(`Failed to discover Eden AI models: HTTP ${response.status}`);
        return getStaticEdenaiModelCatalog();
      }
      const data = (await response.json()) as EdenAiModelsResponse;
      const discovered = (data.data ?? [])
        .map(buildDiscoveredModelDefinition)
        .filter((entry): entry is ModelDefinitionConfig => entry !== null);
      return discovered.length > 0 ? discovered : getStaticEdenaiModelCatalog();
    } finally {
      await release();
    }
  } catch (error) {
    log.warn(`Failed to discover Eden AI models: ${String(error)}`);
    return getStaticEdenaiModelCatalog();
  }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

export function normalizeEdenaiBaseUrl(baseUrl: string | undefined): string | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return undefined;
  }
  if (normalized === EDENAI_BASE_URL || EDENAI_LEGACY_BASE_URLS.has(normalized)) {
    return EDENAI_BASE_URL;
  }
  return undefined;
}

export function buildStaticEdenaiProvider(): ModelProviderConfig {
  return {
    baseUrl: EDENAI_BASE_URL,
    api: "openai-completions",
    models: getStaticEdenaiModelCatalog(),
  };
}

export async function buildEdenaiProvider(): Promise<ModelProviderConfig> {
  return {
    baseUrl: EDENAI_BASE_URL,
    api: "openai-completions",
    models: await discoverEdenaiModels(),
  };
}

export const EDENAI_DYNAMIC_DEFAULTS = {
  contextWindow: EDENAI_DEFAULT_CONTEXT_WINDOW,
  maxTokens: EDENAI_DEFAULT_MAX_TOKENS,
  cost: EDENAI_DEFAULT_COST,
} as const;
