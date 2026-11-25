import { lookup as dnsLookup } from "node:dns/promises";
import {
  fetchLiveProviderModelRows,
  readLiveModelCatalogStringField,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  buildManifestModelProviderConfig,
  getCachedLiveCatalogValue,
} from "openclaw/plugin-sdk/provider-catalog-shared";
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
const INVALID_FEATURED_MODEL_ID_CHARS = new RegExp(String.raw`[\u0000-\u0020\u007f]`);
const INVALID_FEATURED_MODEL_NAME_CHARS = new RegExp(String.raw`[\u0000-\u001f\u007f]`);
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

const lookupNvidiaFeaturedModelHostname: LookupFn = async (hostname, options) =>
  await dnsLookup(hostname, { ...options, family: 4 });

export function buildNvidiaProvider(): ModelProviderConfig {
  const provider = buildManifestModelProviderConfig({
    providerId: "nvidia",
    catalog: manifest.modelCatalog.providers.nvidia,
  });
  for (const model of provider.models) {
    if (model.id === NVIDIA_DEFAULT_MODEL_ID) {
      model.params = {
        ...model.params,
        chat_template_kwargs: {
          ...NVIDIA_ULTRA_DEFAULT_PARAMS.chat_template_kwargs,
          ...(isRecord(model.params?.chat_template_kwargs)
            ? model.params.chat_template_kwargs
            : {}),
        },
      };
    }
  }
  return {
    ...provider,
    apiKey: "NVIDIA_API_KEY",
  };
}

export async function buildLiveNvidiaProvider(): Promise<ModelProviderConfig> {
  const provider = buildNvidiaProvider();
  const [inventory, featured] = await Promise.allSettled([
    getCachedLiveCatalogValue({
      keyParts: ["nvidia", "model-ids", NVIDIA_MODELS_URL],
      load: async (signal) => {
        const rows = await fetchLiveProviderModelRows({
          providerId: "nvidia",
          endpoint: NVIDIA_MODELS_URL,
          requireHttps: true,
          signal,
          readRows: (payload) => {
            if (!isRecord(payload) || !Array.isArray(payload.data)) {
              throw new Error("NVIDIA model inventory must contain data[]");
            }
            return payload.data;
          },
        });
        return rows.map((row) => {
          const id = readLiveModelCatalogStringField(row, "id");
          if (!id) {
            throw new Error("NVIDIA model inventory contains a row without an id");
          }
          return id;
        });
      },
    }),
    getCachedLiveCatalogValue({
      keyParts: ["nvidia", "featured-models", NVIDIA_FEATURED_MODELS_URL],
      ttlMs: FEATURED_MODEL_CACHE_TTL_MS,
      load: async (signal) => {
        const rows = await fetchLiveProviderModelRows({
          providerId: "nvidia",
          endpoint: NVIDIA_FEATURED_MODELS_URL,
          timeoutMs: FEATURED_MODEL_FETCH_TIMEOUT_MS,
          requireHttps: true,
          signal,
          policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(NVIDIA_FEATURED_MODELS_URL),
          // The NVIDIA-owned CloudFront catalog can stall on all-family DNS lookup.
          lookupFn: lookupNvidiaFeaturedModelHostname,
          auditContext: "nvidia-featured-model-catalog",
          readRows: (payload) => {
            if (!isRecord(payload) || !Array.isArray(payload["featured-models"])) {
              throw new Error("NVIDIA featured catalog must contain featured-models[]");
            }
            return payload["featured-models"];
          },
        });
        const models = rows
          .slice(0, FEATURED_MODEL_MAX_ROWS)
          .map(parseNvidiaFeaturedModel)
          .filter((model) => model !== null);
        if (rows.length > 0 && models.length === 0) {
          throw new Error("NVIDIA featured catalog contains no usable model metadata");
        }
        return models;
      },
    }),
  ]);
  if (inventory.status === "rejected") {
    throw inventory.reason;
  }
  // Empty inference inventory is authoritative even when featured metadata is unavailable.
  if (inventory.value.length === 0) {
    return { ...provider, models: [] };
  }
  if (featured.status === "rejected") {
    throw featured.reason;
  }
  const available = new Set(inventory.value);
  const known = new Map(provider.models.map((model) => [model.id, model]));
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
  return {
    ...provider,
    models: [...ranked.values()].filter((model) => available.has(model.id)),
  };
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
    INVALID_FEATURED_MODEL_ID_CHARS.test(id) ||
    INVALID_FEATURED_MODEL_NAME_CHARS.test(name)
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
