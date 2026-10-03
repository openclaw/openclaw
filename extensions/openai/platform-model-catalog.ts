/** Platform account discovery and its manifest fallback share one catalog owner. */
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-model-metadata";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildOpenAIAccountOnlyModels } from "./account-models.js";
import {
  isOpenAIApiBaseUrl,
  isOpenAICodexBaseUrl,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";
import { OPENAI_CHAT_LATEST_MODEL_ID } from "./model-route-contract.js";
import type { OpenAILiveProviderCatalog } from "./model-service-tiers.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
const PROVIDER_ID = "openai";
const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
const OPENAI_MODELS_CACHE_TTL_MS = 60_000;
export const OPENAI_GPT_54_MAX_TOKENS = 128_000;
export const OPENAI_CHAT_LATEST_COST = {
  input: 5,
  output: 30,
  cacheRead: 0.5,
  cacheWrite: 0,
} as const;

export const OPENAI_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: PROVIDER_ID,
  catalog: manifest.modelCatalog.providers.openai,
});

type BuildOpenAILiveProviderConfigParams = {
  apiKey: string;
  baseUrl?: string;
  discoveryApiKey?: string;
  env?: Record<string, string | undefined>;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
};

function buildOpenAIManifestModelsForBaseUrl(baseUrl: string): ModelDefinitionConfig[] {
  return OPENAI_MANIFEST_PROVIDER.models.map((model) => {
    // Manifest templates are shared; each base-URL projection owns its copy.
    const resolved: ModelDefinitionConfig = Object.assign({}, model);
    if (model.api !== "openai-chatgpt-responses" && !isOpenAICodexBaseUrl(model.baseUrl)) {
      resolved.api = model.api ?? OPENAI_MANIFEST_PROVIDER.api ?? "openai-responses";
      resolved.baseUrl = baseUrl;
    }
    return resolved;
  });
}

export function buildOpenAIStaticPlatformProviderConfig(
  apiKey?: string,
  baseUrl = resolveOpenAIDefaultBaseUrl(),
): ModelProviderConfig {
  return {
    baseUrl,
    api: "openai-responses",
    ...(apiKey ? { apiKey } : {}),
    models: buildOpenAIManifestModelsForBaseUrl(baseUrl),
  };
}

export async function buildOpenAILiveProviderConfig(
  params: BuildOpenAILiveProviderConfigParams,
): Promise<OpenAILiveProviderCatalog> {
  const baseUrl =
    normalizeOptionalString(params.baseUrl) ?? resolveOpenAIDefaultBaseUrl(params.env);
  const fallback = buildOpenAIStaticPlatformProviderConfig(params.apiKey, baseUrl);
  const models = fallback.models;
  if (!isOpenAIApiBaseUrl(baseUrl)) {
    return { provider: fallback };
  }
  const [
    { getCachedLiveProviderModelRows, LiveModelCatalogHttpError },
    { isNonSecretApiKeyMarker },
  ] = await Promise.all([
    import("openclaw/plugin-sdk/provider-catalog-live-runtime"),
    import("openclaw/plugin-sdk/provider-auth"),
  ]);
  const rejectionScope =
    params.apiKey && !params.discoveryApiKey && isNonSecretApiKeyMarker(params.apiKey)
      ? "catalog"
      : undefined;
  try {
    const rows = await getCachedLiveProviderModelRows({
      providerId: PROVIDER_ID,
      endpoint: OPENAI_MODELS_ENDPOINT,
      apiKey: params.apiKey,
      discoveryApiKey: params.discoveryApiKey,
      fetchGuard: params.fetchGuard,
      signal: params.signal,
      ttlMs: OPENAI_MODELS_CACHE_TTL_MS,
      auditContext: "openai-model-discovery",
    });
    const discoveredIds = new Set(
      rows.flatMap((row) => {
        const candidate = asOptionalRecord(row);
        if (candidate?.object !== undefined && candidate.object !== "model") {
          return [];
        }
        const modelId = typeof candidate?.id === "string" ? candidate.id.trim() : "";
        return modelId ? [modelId] : [];
      }),
    );
    const selectedIds = new Set<string>();
    const catalogModels = [
      ...models,
      {
        id: OPENAI_CHAT_LATEST_MODEL_ID,
        name: "Chat Latest",
        reasoning: false,
        cost: OPENAI_CHAT_LATEST_COST,
        contextWindow: 400_000,
        api: "openai-responses",
        baseUrl,
        input: ["text", "image"],
        maxTokens: OPENAI_GPT_54_MAX_TOKENS,
      } satisfies ModelDefinitionConfig,
    ];
    // A successful account catalog is authoritative even when it has no
    // visible supported models; static rows cannot grant model access.
    return {
      provider: {
        ...fallback,
        models: [
          ...catalogModels.filter((model) => {
            if (!discoveredIds.has(model.id) || selectedIds.has(model.id)) {
              return false;
            }
            selectedIds.add(model.id);
            return true;
          }),
          ...buildOpenAIAccountOnlyModels({ discoveredIds, catalogModels, baseUrl }),
        ],
      },
      outcome: { provider: PROVIDER_ID, status: "ready" },
    };
  } catch (error) {
    if (
      error instanceof LiveModelCatalogHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      return {
        provider: { ...fallback, models: [] },
        outcome: {
          provider: PROVIDER_ID,
          ...(rejectionScope ? { rejectionScope } : {}),
          status: "auth-rejected",
        },
      };
    }
    return { provider: fallback, outcome: { provider: PROVIDER_ID, status: "unavailable" } };
  }
}
