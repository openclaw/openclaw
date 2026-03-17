import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { CHUTES_DEFAULT_MODEL_REF, applyChutesApiKeyConfig } from "./onboard.js";
import { buildChutesProvider } from "./provider-catalog.js";

const PROVIDER_ID = "chutes";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Chutes Provider",
  description: "Bundled Chutes.ai provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Chutes",
      docsPath: "/providers/chutes",
      envVars: ["CHUTES_API_KEY", "CHUTES_OAUTH_TOKEN"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Chutes API key",
          hint: "Open-source models including Llama, DeepSeek, and more",
          optionKey: "chutesApiKey",
          flagName: "--chutes-api-key",
          envVar: "CHUTES_API_KEY",
          promptMessage: "Enter Chutes API key",
          noteTitle: "Chutes",
          noteMessage: [
            "Chutes provides access to leading open-source models including Llama, DeepSeek, and more.",
            "Get your API key at: https://chutes.ai/settings/api-keys",
          ].join("\n"),
          defaultModel: CHUTES_DEFAULT_MODEL_REF,
          expectedProviders: ["chutes"],
          applyConfig: (cfg) => applyChutesApiKeyConfig(cfg),
          wizard: {
            choiceId: "chutes-api-key",
            choiceLabel: "Chutes API key",
            groupId: "chutes",
            groupLabel: "Chutes",
            groupHint: "OAuth + API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...(await buildChutesProvider(discoveryApiKey)),
              apiKey,
            },
          };
        },
      },
    });
  },
});
