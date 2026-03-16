import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { applyMistralConfig, MISTRAL_DEFAULT_MODEL_REF } from "../../src/commands/onboard-auth.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";

const PROVIDER_ID = "mistral";

const mistralPlugin = {
  id: PROVIDER_ID,
  name: "Mistral Provider",
  description: "Bundled Mistral provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Mistral",
      docsPath: "/providers/models",
      envVars: ["MISTRAL_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Mistral API Key",
          hint: "API Key",
          optionKey: "mistralApiKey",
          flagName: "--mistral-api-key",
          envVar: "MISTRAL_API_KEY",
          promptMessage: "输入 Mistral API Key",
          defaultModel: MISTRAL_DEFAULT_MODEL_REF,
          expectedProviders: ["mistral"],
          applyConfig: (cfg) => applyMistralConfig(cfg),
          wizard: {
            choiceId: "mistral-api-key",
            choiceLabel: "Mistral API Key",
            groupId: "mistral",
            groupLabel: "Mistral AI",
            groupHint: "API Key",
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
  },
};

export default mistralPlugin;
