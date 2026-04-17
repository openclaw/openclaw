import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildNvidiaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nvidia";
const NVIDIA_DEFAULT_MODEL_REF = "nvidia/nemotron-3-super-120b-a12b";

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
              baseUrl: "https://integrate.api.nvidia.com/v1",
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
      buildProvider: buildNvidiaProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    matchesContextOverflowError: ({ errorMessage }) =>
      /\b(?:nvidia|nim)\b.*(?:input.*too long|context.*exceed)/i.test(errorMessage),
  },
});
