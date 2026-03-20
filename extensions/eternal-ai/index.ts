import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyEternalAiConfig, ETERNAL_AI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildEternalAiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "eternal-ai";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Eternal AI Provider",
  description: "Bundled Eternal AI provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Eternal AI",
      envVars: ["ETERNAL_AI_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Eternal AI API key",
          hint: "Uncensored and Private AI",
          optionKey: "eternalAiApiKey",
          flagName: "--eternal-ai-api-key",
          envVar: "ETERNAL_AI_API_KEY",
          promptMessage: "Enter Eternal AI API key",
          defaultModel: ETERNAL_AI_DEFAULT_MODEL_REF,
          expectedProviders: ["eternal-ai"],
          applyConfig: (cfg) => applyEternalAiConfig(cfg),
          wizard: {
            choiceId: "eternal-ai-api-key",
            choiceLabel: "Eternal AI API key",
            groupId: "eternal-ai",
            groupLabel: "Eternal AI",
            groupHint: "Uncensored and Private AI",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildEternalAiProvider,
          }),
      },
    });
  },
});
