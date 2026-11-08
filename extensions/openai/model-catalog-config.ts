import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-model-metadata";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { projectOpenAIAccountModels } from "./account-models.js";
import {
  isOpenAICodexBaseUrl,
  isOpenAIApiBaseUrl,
  resolveOpenAIDefaultBaseUrl,
  type OpenAICodexModelsEndpointContext,
} from "./base-url.js";
import { OPENAI_CHAT_LATEST_MODEL_ID } from "./model-route-contract.js";
import type { OpenAILiveProviderCatalog } from "./model-service-tiers.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { discoverOpenAIPlatformAccessPrograms } from "./platform-access-programs.js";

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
  baseUrl: string;
  discoveryApiKey?: string;
  catalogContext?: OpenAICodexModelsEndpointContext;
};

function buildOpenAIManifestModelsForBaseUrl(baseUrl: string): ModelDefinitionConfig[] {
  return OPENAI_MANIFEST_PROVIDER.models.map((model) =>
    model.api === "openai-chatgpt-responses" || isOpenAICodexBaseUrl(model.baseUrl)
      ? Object.assign({}, model)
      : Object.assign({}, model, {
          api: model.api ?? OPENAI_MANIFEST_PROVIDER.api ?? "openai-responses",
          baseUrl,
        }),
  );
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
  const baseUrl = params.baseUrl;
  const fallback = buildOpenAIStaticPlatformProviderConfig(params.apiKey, baseUrl);
  if (!isOpenAIApiBaseUrl(baseUrl)) {
    return { provider: fallback };
  }
  const [{ buildLiveModelProviderConfig, LiveModelCatalogHttpError }, { isNonSecretApiKeyMarker }] =
    await Promise.all([
      import("openclaw/plugin-sdk/provider-catalog-live-runtime"),
      import("openclaw/plugin-sdk/provider-auth"),
    ]);
  const rejectionScope =
    params.apiKey && !params.discoveryApiKey && isNonSecretApiKeyMarker(params.apiKey)
      ? "catalog"
      : undefined;
  const { models, ...providerConfig } = fallback;
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
  try {
    // A successful account catalog is authoritative even when it has no
    // visible supported models; catalog rows only describe listed ids.
    const provider = await buildLiveModelProviderConfig({
      discoveryMode: "strict",
      providerId: PROVIDER_ID,
      endpoint: OPENAI_MODELS_ENDPOINT,
      providerConfig,
      models: catalogModels,
      apiKey: params.apiKey,
      discoveryApiKey: params.discoveryApiKey,
      ttlMs: OPENAI_MODELS_CACHE_TTL_MS,
      auditContext: "openai-model-discovery",
    });
    const listedModels = new Set(provider.models.map((model) => model.id));
    const modelAccessPrograms = (
      await discoverOpenAIPlatformAccessPrograms({
        apiKey: params.discoveryApiKey ?? params.apiKey,
        catalogContext: params.catalogContext,
      })
    )?.filter((observation) => listedModels.has(observation.modelId));
    return {
      provider: {
        ...provider,
        models: projectOpenAIAccountModels({
          listedModels: provider.models,
          catalogModels,
          baseUrl,
        }),
      },
      outcome: {
        provider: PROVIDER_ID,
        status: "ready",
        ...(modelAccessPrograms?.length ? { modelAccessPrograms } : {}),
      },
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
