import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyNebiusConfig, NEBIUS_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildNebiusProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nebius";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Nebius Token Factory Provider",
  description:
    "40+ open-source models (DeepSeek, Qwen, Llama, GLM, Kimi, Nemotron) via Nebius Token Factory — OpenAI-compatible endpoint",
  provider: {
    label: "Nebius Token Factory",
    docsPath: "/providers/nebius",
    auth: [
      {
        methodId: "api-key",
        label: "Nebius Token Factory API key",
        hint: "API key from studio.nebius.ai",
        optionKey: "nebiusApiKey",
        flagName: "--nebius-api-key",
        envVar: "NEBIUS_API_KEY",
        promptMessage:
          "Enter your Nebius Token Factory API key (get one at studio.nebius.ai)",
        defaultModel: NEBIUS_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyNebiusConfig(cfg),
        wizard: {
          choiceId: "nebius-api-key",
          choiceLabel: "Nebius Token Factory API key",
          groupId: "nebius",
          groupLabel: "Nebius Token Factory",
          groupHint: "40+ open-source models · studio.nebius.ai",
        },
      },
    ],
    catalog: {
      buildProvider: buildNebiusProvider,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    matchesContextOverflowError: ({ errorMessage }) =>
      /(?:context|input).*(?:too long|exceed|limit)/i.test(errorMessage),
  },
});
