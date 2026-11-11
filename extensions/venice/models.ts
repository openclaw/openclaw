import { floorPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import {
  buildManifestModelProviderConfig,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { parseVeniceModelPricing } from "./pricing-api.js";

const VENICE_MANIFEST_CATALOG = manifest.modelCatalog.providers.venice;

export const VENICE_BASE_URL = VENICE_MANIFEST_CATALOG.baseUrl;
export const VENICE_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "venice")!;

const VENICE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const VENICE_DEFAULT_CONTEXT_WINDOW = 128_000;
const VENICE_DEFAULT_MAX_TOKENS = 4096;
const VENICE_DISCOVERY_HARD_MAX_TOKENS = 131_072;
const VENICE_DISCOVERY_TIMEOUT_MS = 10_000;
const VENICE_DISCOVERY_CACHE_TTL_MS = 60_000;

export const VENICE_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: "venice",
  catalog: VENICE_MANIFEST_CATALOG,
}).models;

interface VeniceModelSpec {
  name: string;
  availableContextTokens?: number;
  maxCompletionTokens?: number;
  pricing?: unknown;
  capabilities?: {
    supportsReasoning?: boolean;
    supportsVision?: boolean;
    supportsFunctionCalling?: boolean;
  };
}

interface VeniceModel {
  id: string;
  model_spec?: VeniceModelSpec;
}

function projectVeniceModels(
  rows: readonly unknown[],
  fallback: ModelProviderConfig,
): ModelDefinitionConfig[] {
  const catalogById = new Map(fallback.models.map((model) => [model.id, model]));
  const models: ModelDefinitionConfig[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const apiModel = row as VeniceModel;
    if (typeof apiModel.id !== "string" || !apiModel.id.trim()) {
      continue;
    }
    const catalogEntry = catalogById.get(apiModel.id);
    const liveCost = parseVeniceModelPricing(apiModel.model_spec?.pricing);
    const knownMaxTokens = catalogEntry?.maxTokens;
    const raw = floorPositiveFiniteNumber(apiModel.model_spec?.maxCompletionTokens);
    let apiMaxTokens: number | undefined;
    if (raw) {
      const contextWindow = floorPositiveFiniteNumber(apiModel.model_spec?.availableContextTokens);
      const knownCap = knownMaxTokens === undefined ? undefined : Math.floor(knownMaxTokens);
      const hardCap = knownCap ?? VENICE_DISCOVERY_HARD_MAX_TOKENS;
      const fallbackContextWindow = knownCap ?? VENICE_DEFAULT_CONTEXT_WINDOW;
      apiMaxTokens = Math.min(raw, contextWindow ?? fallbackContextWindow, hardCap);
    }
    const supportsTools = apiModel.model_spec?.capabilities?.supportsFunctionCalling;
    if (catalogEntry) {
      const definition: ModelDefinitionConfig = {
        ...catalogEntry,
        cost: liveCost ?? catalogEntry.cost,
      };
      if (apiMaxTokens !== undefined) {
        definition.maxTokens = apiMaxTokens;
      }
      if (supportsTools === false) {
        definition.compat = {
          ...definition.compat,
          supportsTools: false,
        };
      }
      models.push(definition);
    } else {
      const apiSpec = apiModel.model_spec;
      const lowerModelId = normalizeLowercaseStringOrEmpty(apiModel.id);
      const isReasoning =
        apiSpec?.capabilities?.supportsReasoning ||
        lowerModelId.includes("thinking") ||
        lowerModelId.includes("reason") ||
        lowerModelId.includes("r1");
      const hasVision = apiSpec?.capabilities?.supportsVision === true;
      models.push({
        id: apiModel.id,
        name: apiSpec?.name || apiModel.id,
        reasoning: isReasoning,
        input: hasVision ? ["text", "image"] : ["text"],
        cost: liveCost ?? VENICE_DEFAULT_COST,
        contextWindow:
          floorPositiveFiniteNumber(apiSpec?.availableContextTokens) ??
          VENICE_DEFAULT_CONTEXT_WINDOW,
        maxTokens: apiMaxTokens ?? VENICE_DEFAULT_MAX_TOKENS,
        compat: {
          supportsUsageInStreaming: false,
          ...(supportsTools === false ? { supportsTools: false } : {}),
        },
      });
    }
  }
  return models;
}

export const VENICE_MODEL_DISCOVERY_OPTIONS = {
  timeoutMs: VENICE_DISCOVERY_TIMEOUT_MS,
  ttlMs: VENICE_DISCOVERY_CACHE_TTL_MS,
  authentication: "none",
  projectRows: projectVeniceModels,
} as const;
