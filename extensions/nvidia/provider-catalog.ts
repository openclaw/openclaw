import type { LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  getCachedLiveProviderModelRows,
  readLiveModelCatalogStringField,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  type LookupFn,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  asOptionalObjectRecord,
  asSafeIntegerInRange,
  containsAsciiControlCharacter,
  isRecord,
  normalizeBoundedOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

export const NVIDIA_DEFAULT_MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";
const NVIDIA_FEATURED_MODELS_URL =
  "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json";

const FEATURED_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FEATURED_MODEL_FETCH_TIMEOUT_MS = 10_000;
const FEATURED_MODEL_MAX_ROWS = 32;
const FEATURED_MODEL_MAX_ID_LENGTH = 200;
const FEATURED_MODEL_MAX_NAME_LENGTH = 200;
const FEATURED_MODEL_MAX_CONTEXT_WINDOW = 10_000_000;
const FEATURED_MODEL_MAX_OUTPUT_TOKENS = 1_000_000;
const FEATURED_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;
const NVIDIA_ULTRA_DEFAULT_PARAMS = {
  chat_template_kwargs: {
    enable_thinking: false,
    force_nonempty_content: true,
  },
} as const;
const DEPRECATED_NVIDIA_MODEL_IDS = new Set<string>(
  manifest.modelCatalog.providers.nvidia.models
    .filter((model) => "status" in model && model.status === "deprecated")
    .map((model) => model.id),
);

const lookupNvidiaFeaturedModelHostname = (async (
  hostname: string,
  options?: number | LookupOptions,
) => {
  if (typeof options === "object" && options !== null) {
    return await dnsLookup(hostname, { ...options, family: 4 });
  }
  return await dnsLookup(hostname, { family: 4 });
}) as LookupFn;

export function buildNvidiaProvider(): ModelProviderConfig {
  const provider = buildManifestModelProviderConfig({
    providerId: "nvidia",
    catalog: manifest.modelCatalog.providers.nvidia,
  });
  return {
    ...provider,
    apiKey: "NVIDIA_API_KEY",
    models: applyNvidiaModelDefaults(provider.models),
  };
}

export function buildSelectableNvidiaProvider(): ModelProviderConfig {
  const provider = buildNvidiaProvider();
  return {
    ...provider,
    models: provider.models.filter((model) => !DEPRECATED_NVIDIA_MODEL_IDS.has(model.id)),
  };
}

export async function buildLiveNvidiaProvider(): Promise<ModelProviderConfig> {
  const provider = buildNvidiaProvider();
  return {
    ...provider,
    models: await loadNvidiaLiveModels(provider.models),
  };
}

async function loadNvidiaLiveModels(
  bundledModels: ModelDefinitionConfig[],
): Promise<ModelDefinitionConfig[]> {
  const [inventory, featured] = await Promise.allSettled([
    getCachedLiveProviderModelRows({
      providerId: "nvidia",
      endpoint: NVIDIA_MODELS_URL,
      requireHttps: true,
      readRows: (payload) => {
        if (!isRecord(payload) || !Array.isArray(payload.data)) {
          throw new Error("NVIDIA model inventory must contain data[]");
        }
        if (payload.data.some((row) => !readLiveModelCatalogStringField(row, "id"))) {
          throw new Error("NVIDIA model inventory contains a row without an id");
        }
        return payload.data;
      },
    }),
    loadNvidiaFeaturedModels(),
  ]);
  if (inventory.status === "rejected") {
    throw inventory.reason;
  }
  // Empty inference inventory is authoritative even when featured metadata is unavailable.
  if (inventory.value.length === 0) {
    return [];
  }
  if (featured.status === "rejected") {
    throw featured.reason;
  }
  const available = new Set(
    inventory.value.map((row) => readLiveModelCatalogStringField(row, "id")),
  );
  const known = new Map(bundledModels.map((model) => [model.id, model]));
  // /models includes embeddings and other non-chat endpoints without capabilities.
  // Only exact known chat metadata or the vendor's featured chat rows are selectable.
  const ranked = new Map(
    featured.value.map((model) => {
      const bundled = known.get(model.id);
      return [
        model.id,
        bundled
          ? {
              ...bundled,
              name: model.name,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            }
          : model,
      ];
    }),
  );
  for (const [id, model] of known) {
    if (!ranked.has(id)) {
      ranked.set(id, model);
    }
  }
  // A fresh inventory can restore a republished legacy id, but a stale featured
  // recommendation cannot restore an id the inference endpoint no longer lists.
  return [...ranked.values()].filter((model) => available.has(model.id));
}

async function loadNvidiaFeaturedModels(): Promise<ModelDefinitionConfig[]> {
  const rows = await getCachedLiveProviderModelRows({
    providerId: "nvidia",
    endpoint: NVIDIA_FEATURED_MODELS_URL,
    timeoutMs: FEATURED_MODEL_FETCH_TIMEOUT_MS,
    ttlMs: FEATURED_MODEL_CACHE_TTL_MS,
    requireHttps: true,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(NVIDIA_FEATURED_MODELS_URL),
    // The featured catalog is an NVIDIA-owned CloudFront URL. Some resolvers
    // stall for seconds on the default all-family lookup; IPv4 pinning keeps
    // the guarded fixed-host fetch on the fast path.
    lookupFn: lookupNvidiaFeaturedModelHostname,
    auditContext: "nvidia-featured-model-catalog",
    shouldCacheRows: (modelRows) => parseNvidiaFeaturedModels(modelRows) !== null,
    readRows: (payload) => {
      if (!isRecord(payload) || !Array.isArray(payload["featured-models"])) {
        throw new Error("NVIDIA featured catalog must contain featured-models[]");
      }
      return payload["featured-models"];
    },
  });
  const models = parseNvidiaFeaturedModels(rows);
  if (!models) {
    throw new Error("NVIDIA featured catalog contains no usable model metadata");
  }
  return models;
}

function parseNvidiaFeaturedModels(rows: readonly unknown[]): ModelDefinitionConfig[] | null {
  const models = rows
    .slice(0, FEATURED_MODEL_MAX_ROWS)
    .map(parseNvidiaFeaturedModel)
    .filter((model) => model !== null);
  return rows.length === 0 || models.length > 0 ? models : null;
}

function applyNvidiaModelDefaults(models: ModelDefinitionConfig[]): ModelDefinitionConfig[] {
  return models.map((model) =>
    model.id === NVIDIA_DEFAULT_MODEL_ID
      ? {
          ...model,
          params: {
            ...model.params,
            chat_template_kwargs: {
              ...NVIDIA_ULTRA_DEFAULT_PARAMS.chat_template_kwargs,
              ...(isRecord(model.params?.chat_template_kwargs)
                ? model.params.chat_template_kwargs
                : {}),
            },
          },
        }
      : model,
  );
}

function parseNvidiaFeaturedModel(row: unknown): ModelDefinitionConfig | null {
  const entry = asOptionalObjectRecord(row);
  const id = normalizeBoundedOptionalString(entry?.model, FEATURED_MODEL_MAX_ID_LENGTH);
  const name = normalizeBoundedOptionalString(
    entry?.["model-name"],
    FEATURED_MODEL_MAX_NAME_LENGTH,
  );
  const contextWindow = asSafeIntegerInRange(entry?.context, {
    min: 1,
    max: FEATURED_MODEL_MAX_CONTEXT_WINDOW,
  });
  const maxTokens = asSafeIntegerInRange(entry?.["max-output"], {
    min: 1,
    max: FEATURED_MODEL_MAX_OUTPUT_TOKENS,
  });
  if (
    !id ||
    !name ||
    !contextWindow ||
    !maxTokens ||
    containsAsciiControlCharacter(id) ||
    id.includes(" ") ||
    containsAsciiControlCharacter(name)
  ) {
    return null;
  }
  return {
    id: id.includes("/") ? id : `nvidia/${id}`,
    name,
    reasoning: false,
    input: ["text"],
    contextWindow,
    maxTokens,
    cost: { ...FEATURED_MODEL_COST },
    compat: {
      requiresStringContent: true,
    },
  };
}
