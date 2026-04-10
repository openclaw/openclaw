import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { applyNexosConfig, NEXOS_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildNexosProvider } from "./provider-catalog.js";

const PROVIDER_ID = "nexos";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Nexos Provider",
  description: "Bundled Nexos AI provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Nexos AI",
      docsPath: "/providers/nexos",
      envVars: ["NEXOS_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Nexos AI API key",
          hint: "API key",
          optionKey: "nexosApiKey",
          flagName: "--nexos-api-key",
          envVar: "NEXOS_API_KEY",
          promptMessage: "Enter Nexos AI API key",
          defaultModel: NEXOS_DEFAULT_MODEL_REF,
          expectedProviders: ["nexos"],
          applyConfig: (cfg) => applyNexosConfig(cfg),
          wizard: {
            choiceId: "nexos-api-key",
            choiceLabel: "Nexos AI API key",
            groupId: "nexos",
            groupLabel: "Nexos AI",
            groupHint: "API key",
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
              ...(await buildNexosProvider(discoveryApiKey)),
              apiKey,
            },
          };
        },
      },
    });
  },
});
