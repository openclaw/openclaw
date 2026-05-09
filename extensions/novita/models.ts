import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

const log = createSubsystemLogger("novita-models");

export const NOVITA_BASE_URL = "https://api.novita.ai/openai/v1";
export const NOVITA_MODELS_URL = `${NOVITA_BASE_URL}/models`;
export const NOVITA_DEFAULT_MODEL_ID = "moonshotai/kimi-k2.6";
export const NOVITA_DEFAULT_MODEL_REF = `novita/${NOVITA_DEFAULT_MODEL_ID}`;
export const NOVITA_DISCOVERY_TIMEOUT_MS = 10_000;

const NOVITA_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

type NovitaStaticCatalogEntry = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  cost: ModelDefinitionConfig["cost"];
};

export const NOVITA_MODEL_CATALOG: NovitaStaticCatalogEntry[] = [
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    cost: NOVITA_DEFAULT_COST,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 393_216,
    cost: NOVITA_DEFAULT_COST,
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6",
    reasoning: true,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    cost: NOVITA_DEFAULT_COST,
  },
  {
    id: "zai-org/glm-5.1",
    name: "GLM-5.1",
    reasoning: true,
    input: ["text"],
    contextWindow: 204_800,
    maxTokens: 96_000,
    cost: NOVITA_DEFAULT_COST,
  },
  {
    id: "xiaomimimo/mimo-v2.5-pro",
    name: "Xiaomi MiMo V2.5 Pro",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    cost: NOVITA_DEFAULT_COST,
  },
  {
    id: "minimax/minimax-m2.7",
    name: "MiniMax M2.7",
    reasoning: true,
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    cost: NOVITA_DEFAULT_COST,
  },
];

type NovitaModelEntry = {
  id?: unknown;
  title?: unknown;
  display_name?: unknown;
  description?: unknown;
  input_modalities?: unknown;
  features?: unknown;
  tags?: unknown;
  context_size?: unknown;
  max_output_tokens?: unknown;
  input_token_price_per_m?: unknown;
  output_token_price_per_m?: unknown;
};

type NovitaModelsResponse = {
  data?: unknown;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;

type CacheEntry = {
  models: ModelDefinitionConfig[];
  time: number;
};

const modelCache = new Map<string, CacheEntry>();

export function clearNovitaModelCacheForTests(): void {
  modelCache.clear();
}

function buildStaticCatalog(): ModelDefinitionConfig[] {
  return NOVITA_MODEL_CATALOG.map(buildNovitaModelDefinition);
}

function pruneExpiredCacheEntries(now = Date.now()): void {
  for (const [key, entry] of modelCache.entries()) {
    if (now - entry.time >= CACHE_TTL_MS) {
      modelCache.delete(key);
    }
  }
}

function cacheAndReturn(
  tokenKey: string,
  models: ModelDefinitionConfig[],
): ModelDefinitionConfig[] {
  const now = Date.now();
  pruneExpiredCacheEntries(now);
  if (!modelCache.has(tokenKey) && modelCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = modelCache.keys().next();
    if (!oldest.done) {
      modelCache.delete(oldest.value);
    }
  }
  modelCache.set(tokenKey, { models, time: now });
  return models;
}

function normalizeNumber(value: unknown): number | undefined {
  const num =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function parseInputModalities(entry: NovitaModelEntry): Array<"text" | "image"> {
  if (!Array.isArray(entry.input_modalities)) {
    return ["text"];
  }
  const normalized = entry.input_modalities.map((item) =>
    typeof item === "string" ? normalizeLowercaseStringOrEmpty(item) : "",
  );
  return normalized.includes("image") ? ["text", "image"] : ["text"];
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? normalizeLowercaseStringOrEmpty(item) : ""))
        .filter(Boolean)
    : [];
}

function inferReasoning(entry: NovitaModelEntry, id: string): boolean {
  const markers = [
    id,
    normalizeOptionalString(entry.title) ?? "",
    normalizeOptionalString(entry.display_name) ?? "",
    ...readStringList(entry.features),
    ...readStringList(entry.tags),
  ]
    .join(" ")
    .toLowerCase();
  return /\b(?:reasoning|reasoner|thinking|r1)\b/u.test(markers) || markers.includes("glm-5");
}

function displayName(entry: NovitaModelEntry, id: string): string {
  return (
    normalizeOptionalString(entry.display_name) ??
    normalizeOptionalString(entry.title) ??
    normalizeOptionalString(entry.description) ??
    id
  );
}

function pricePerMillionDollars(value: unknown): number {
  const num = normalizeNumber(value);
  return num ? num / 1000 : 0;
}

function buildNovitaModelFromApiEntry(entry: NovitaModelEntry): ModelDefinitionConfig | undefined {
  const id = normalizeOptionalString(entry.id);
  if (!id) {
    return undefined;
  }
  return {
    id,
    name: displayName(entry, id),
    reasoning: inferReasoning(entry, id),
    input: parseInputModalities(entry),
    cost: {
      input: pricePerMillionDollars(entry.input_token_price_per_m),
      output: pricePerMillionDollars(entry.output_token_price_per_m),
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: normalizeNumber(entry.context_size) ?? 131_072,
    maxTokens: normalizeNumber(entry.max_output_tokens) ?? 8192,
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  };
}

export function buildNovitaModelDefinition(model: NovitaStaticCatalogEntry): ModelDefinitionConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  };
}

function isNovitaModelDiscoveryTestEnvironment(): boolean {
  return process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
}

export async function discoverNovitaModels(apiKey?: string): Promise<ModelDefinitionConfig[]> {
  const trimmedKey = apiKey?.trim() ?? "";
  const now = Date.now();
  pruneExpiredCacheEntries(now);
  const cached = modelCache.get(trimmedKey);
  if (cached) {
    return cached.models;
  }

  if (!trimmedKey || isNovitaModelDiscoveryTestEnvironment()) {
    return cacheAndReturn(trimmedKey, buildStaticCatalog());
  }

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: NOVITA_MODELS_URL,
      init: {
        signal: AbortSignal.timeout(NOVITA_DISCOVERY_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          Accept: "application/json",
        },
      },
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(NOVITA_BASE_URL),
      auditContext: "novita-model-discovery",
    });
    try {
      if (!response.ok) {
        log.warn(`GET /models failed: HTTP ${response.status}, using static Novita catalog`);
        return cacheAndReturn(trimmedKey, buildStaticCatalog());
      }
      const body = (await response.json()) as NovitaModelsResponse;
      const data = Array.isArray(body?.data) ? body.data : [];
      if (data.length === 0) {
        log.warn("Novita model discovery returned no models, using static catalog");
        return cacheAndReturn(trimmedKey, buildStaticCatalog());
      }
      const seen = new Set<string>();
      const models: ModelDefinitionConfig[] = [];
      for (const raw of data) {
        if (!raw || typeof raw !== "object") {
          continue;
        }
        const model = buildNovitaModelFromApiEntry(raw as NovitaModelEntry);
        if (!model || seen.has(model.id)) {
          continue;
        }
        seen.add(model.id);
        models.push(model);
      }
      return cacheAndReturn(trimmedKey, models.length > 0 ? models : buildStaticCatalog());
    } finally {
      await release();
    }
  } catch (error) {
    log.warn(`Novita model discovery failed: ${String(error)}, using static catalog`);
    return cacheAndReturn(trimmedKey, buildStaticCatalog());
  }
}
