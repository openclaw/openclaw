// Adorbis plugin entrypoint registers its OpenClaw provider integration.
import { getCachedLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import {
  buildProviderReplayFamilyHooks,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";

const PROVIDER_ID = "adorbis";
const ADORBIS_BASE_URL = "https://api.adorbistech.com/v1";
const ADORBIS_MODELS_ENDPOINT = `${ADORBIS_BASE_URL}/models`;
const ADORBIS_DISCOVERY_TIMEOUT_MS = 10_000;
const ADORBIS_DISCOVERY_CACHE_TTL_MS = 60_000;

const DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function readAdorbisModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function buildAdorbisModelDefinition(modelId: string): ModelDefinitionConfig {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: DEFAULT_COST,
    contextWindow: 128_000,
    maxTokens: 8192,
    compat: {
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  };
}

async function discoverAdorbisModels(params: {
  apiKey: string;
  discoveryApiKey?: string;
}): Promise<ModelDefinitionConfig[]> {
  const rows = await getCachedLiveProviderModelRows({
    providerId: PROVIDER_ID,
    endpoint: ADORBIS_MODELS_ENDPOINT,
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    timeoutMs: ADORBIS_DISCOVERY_TIMEOUT_MS,
    ttlMs: ADORBIS_DISCOVERY_CACHE_TTL_MS,
    shouldCacheRows: (cachedRows) => cachedRows.some((row) => Boolean(readAdorbisModelId(row))),
  });
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const modelId = readAdorbisModelId(row);
    if (!modelId || seen.has(modelId)) {
      return [];
    }
    seen.add(modelId);
    return [buildAdorbisModelDefinition(modelId)];
  });
}

async function buildAdorbisProvider(params: {
  apiKey: string;
  discoveryApiKey?: string;
}): Promise<ModelProviderConfig> {
  return {
    baseUrl: ADORBIS_BASE_URL,
    api: "openai-completions",
    models: await discoverAdorbisModels(params),
  };
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Adorbis AI Provider",
  description: "Bundled Adorbis AI provider plugin",
  provider: {
    label: "Adorbis AI",
    docsPath: "/providers/adorbis",
    envVars: ["ADORBIS_API_KEY"],
    auth: [
      {
        methodId: "api-key",
        label: "Adorbis AI API key",
        hint: "Sovereign OpenAI-compatible gateway",
        optionKey: "adorbisApiKey",
        flagName: "--adorbis-api-key",
        envVar: "ADORBIS_API_KEY",
        promptMessage: "Enter Adorbis AI API key",
        wizard: {
          groupLabel: "Adorbis AI",
          groupHint: "Sovereign multi-vendor AI gateway",
          onboardingScopes: ["text-inference"],
        },
      },
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
        const apiKey = auth.apiKey;
        if (!apiKey) {
          return null;
        }
        return {
          provider: {
            ...(await buildAdorbisProvider({ ...auth, apiKey })),
            apiKey,
          },
        };
      },
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
  },
});
