import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { applyMistralModelCompat } from "./api.js";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyMistralConfig, MISTRAL_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildMistralProvider } from "./provider-catalog.js";

const PROVIDER_ID = "mistral";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Mistral Provider",
  description: "Bundled Mistral provider plugin",
  provider: {
    label: "Mistral",
    docsPath: "/providers/models",
    auth: [
      {
        methodId: "api-key",
        label: "Mistral API key",
        hint: "API key",
        optionKey: "mistralApiKey",
        flagName: "--mistral-api-key",
        envVar: "MISTRAL_API_KEY",
        promptMessage: "Enter Mistral API key",
        defaultModel: MISTRAL_DEFAULT_MODEL_REF,
        applyConfig: (cfg) => applyMistralConfig(cfg),
        wizard: {
          groupLabel: "Mistral AI",
        },
      },
    ],
    catalog: {
      buildProvider: buildMistralProvider,
      allowExplicitBaseUrl: true,
    },
    normalizeResolvedModel: ({ model }) => applyMistralModelCompat(model),
    capabilities: {
      transcriptToolCallIdMode: "strict9",
      transcriptToolCallIdModelHints: [
        "mistral",
        "mixtral",
        "codestral",
        "pixtral",
        "devstral",
        "ministral",
        "mistralai",
      ],
    },
  },
  register(api) {
    api.registerMediaUnderstandingProvider(mistralMediaUnderstandingProvider);
  },
});
