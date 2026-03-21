import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { mistralMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { applyMistralConfig, MISTRAL_DEFAULT_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "mistral";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Mistral Provider",
  description: "Bundled Mistral provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Mistral",
      docsPath: "/providers/models",
      envVars: ["MISTRAL_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Mistral API key",
          hint: "API key",
          optionKey: "mistralApiKey",
          flagName: "--mistral-api-key",
          envVar: "MISTRAL_API_KEY",
          promptMessage: "Enter Mistral API key",
          defaultModel: MISTRAL_DEFAULT_MODEL_REF,
          expectedProviders: ["mistral"],
          applyConfig: (cfg) => applyMistralConfig(cfg),
          wizard: {
            choiceId: "mistral-api-key",
            choiceLabel: "Mistral API key",
            groupId: "mistral",
            groupLabel: "Mistral AI",
            groupHint: "API key",
          },
        }),
      ],
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
    });
    api.registerMediaUnderstandingProvider(mistralMediaUnderstandingProvider);
  },
});
