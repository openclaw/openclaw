import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const NVIDIA_DEFAULT_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b";
export const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";

const FEATURED_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FEATURED_MODEL_FETCH_TIMEOUT_MS = 2500;
const FEATURED_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

type NvidiaFeaturedModel = {
  model: string;
  "model-name": string;
  context: number;
  "max-output": number;
};

let featuredModelCache:
  | {
      expiresAtMs: number;
      models: ModelDefinitionConfig[];
    }
  | undefined;
let featuredModelRequest: Promise<ModelDefinitionConfig[] | null> | undefined;

export function buildNvidiaProvider(): ModelProviderConfig {
  return {
    ...buildManifestModelProviderConfig({
      providerId: "nvidia",
      catalog: manifest.modelCatalog.providers.nvidia,
    }),
    apiKey: "NVIDIA_API_KEY",
  };
}

export async function buildLiveNvidiaProvider(): Promise<ModelProviderConfig> {
  const provider = buildNvidiaProvider();
  const featuredModels = await loadNvidiaFeaturedModels();
  if (!featuredModels || featuredModels.length === 0) {
    return provider;
  }
  return {
    ...provider,
    models: mergeFeaturedModels(featuredModels, provider.models),
  };
}

export function clearNvidiaFeaturedModelCacheForTests() {
  featuredModelCache = undefined;
  featuredModelRequest = undefined;
}

async function loadNvidiaFeaturedModels(): Promise<ModelDefinitionConfig[] | null> {
  const now = Date.now();
  if (featuredModelCache && featuredModelCache.expiresAtMs > now) {
    return featuredModelCache.models;
  }
  featuredModelRequest ??= fetchNvidiaFeaturedModels();
  try {
    const models = await featuredModelRequest;
    if (models && models.length > 0) {
      featuredModelCache = {
        expiresAtMs: now + FEATURED_MODEL_CACHE_TTL_MS,
        models,
      };
    }
    return models;
  } finally {
    featuredModelRequest = undefined;
  }
}

async function fetchNvidiaFeaturedModels(): Promise<ModelDefinitionConfig[] | null> {
  try {
    const response = await fetch(NVIDIA_FEATURED_MODELS_URL, {
      signal: AbortSignal.timeout(FEATURED_MODEL_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    return parseNvidiaFeaturedModels(await response.json());
  } catch {
    return null;
  }
}

function parseNvidiaFeaturedModels(payload: unknown): ModelDefinitionConfig[] | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const rows = (payload as { "featured-models"?: unknown })["featured-models"];
  if (!Array.isArray(rows)) {
    return null;
  }
  const models = rows.map(parseNvidiaFeaturedModel).filter((model) => model !== null);
  return models.length > 0 ? models : null;
}

function parseNvidiaFeaturedModel(row: unknown): ModelDefinitionConfig | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const entry = row as Partial<NvidiaFeaturedModel>;
  if (
    typeof entry.model !== "string" ||
    typeof entry["model-name"] !== "string" ||
    !isPositiveInteger(entry.context) ||
    !isPositiveInteger(entry["max-output"])
  ) {
    return null;
  }
  const id = normalizeNvidiaFeaturedModelId(entry.model);
  const name = entry["model-name"].trim();
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    contextWindow: entry.context,
    maxTokens: entry["max-output"],
    cost: { ...FEATURED_MODEL_COST },
    compat: {
      requiresStringContent: true,
    },
  };
}

function normalizeNvidiaFeaturedModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.includes("/") ? trimmed : `nvidia/${trimmed}`;
}

function mergeFeaturedModels(
  featuredModels: ModelDefinitionConfig[],
  fallbackModels: ModelDefinitionConfig[],
): ModelDefinitionConfig[] {
  const seen = new Set<string>();
  const merged: ModelDefinitionConfig[] = [];
  for (const model of [...featuredModels, ...fallbackModels]) {
    const key = model.id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
