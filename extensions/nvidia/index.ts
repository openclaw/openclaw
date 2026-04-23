import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildNvidiaProvider, NVIDIA_CATALOGED_MODELS, NVIDIA_BASE_URL } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";
const NVIDIA_DEFAULT_MODEL_REF = "nvidia/nemotron-3-super-120b-a12b";

type NvidiaPluginConfig = {
  discovery?: {
    enabled?: boolean;
  };
};

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "NVIDIA Provider",
  description: "Bundled NVIDIA provider plugin",
  provider: {
    label: "NVIDIA",
    docsPath: "/providers/nvidia",
    envVars: ["NVIDIA_API_KEY"],
    auth: [
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "api-key",
        label: "NVIDIA API key",
        hint: "NVIDIA NIM API key",
        optionKey: "nvidiaApiKey",
        flagName: "--nvidia-api-key",
        envVar: "NVIDIA_API_KEY",
        promptMessage: "Enter NVIDIA API key",
        defaultModel: NVIDIA_DEFAULT_MODEL_REF,
        expectedProviders: ["nvidia"],
        applyConfig: (cfg) => ({
          ...cfg,
          providers: {
            ...cfg.providers,
            [PROVIDER_ID]: {
              ...(cfg.providers as Record<string, unknown>)?.[PROVIDER_ID] as Record<string, unknown>,
              baseUrl: NVIDIA_BASE_URL,
              api: "openai-completions",
            },
          },
        }),
        wizard: {
          choiceId: "nvidia-api-key",
          choiceLabel: "NVIDIA API key",
          groupId: "nvidia",
          groupLabel: "NVIDIA",
          groupHint: "NVIDIA NIM API key",
        },
      }),
    ],
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const pluginEntry = ctx.config?.plugins?.entries?.[PROVIDER_ID];
        const pluginConfig =
          pluginEntry && typeof pluginEntry === "object" && pluginEntry.config
            ? (pluginEntry.config as NvidiaPluginConfig)
            : undefined;
        const discoveryEnabled =
          pluginConfig?.discovery?.enabled ?? ctx.config?.models?.nvidiaDiscovery?.enabled;
        if (discoveryEnabled === false) {
          return null;
        }
        const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        return {
          provider: {
            ...(await buildNvidiaProvider(discoveryApiKey)),
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
    matchesContextOverflowError: ({ errorMessage }) =>
      /\b(?:nvidia|nim)\b.*(?:input.*too long|context.*exceed)/i.test(errorMessage),
    resolveDynamicModel: (ctx) => {
      const modelId = ctx.modelId.trim();
      const catalogEntry = NVIDIA_CATALOGED_MODELS.find((m) => m.id === modelId);
      if (catalogEntry) {
        return {
          id: catalogEntry.id,
          name: catalogEntry.name,
          api: "openai-completions",
          provider: PROVIDER_ID,
          baseUrl: NVIDIA_BASE_URL,
          reasoning: catalogEntry.reasoning,
          input: catalogEntry.input,
          cost: catalogEntry.cost,
          contextWindow: catalogEntry.contextWindow,
          maxTokens: catalogEntry.maxTokens,
        };
      }
      return {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: NVIDIA_BASE_URL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      };
    },
  },
});
