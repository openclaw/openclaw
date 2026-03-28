import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { applyFptAiFactoryConfig, FPT_AI_FACTORY_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildFptAiFactoryProvider } from "./provider-catalog.js";

const PROVIDER_ID = "fpt-ai-factory";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "FPT AI Factory Provider",
  description: "Bundled FPT AI Factory provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "FPT AI Factory",
      docsPath: "/providers/fpt-ai-factory",
      envVars: ["FPT_AI_FACTORY_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "FPT AI Factory API key",
          hint: "OpenAI-compatible API key",
          optionKey: "fptAiFactoryApiKey",
          flagName: "--fpt-ai-factory-api-key",
          envVar: "FPT_AI_FACTORY_API_KEY",
          promptMessage: "Enter FPT AI Factory API key",
          defaultModel: FPT_AI_FACTORY_DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyFptAiFactoryConfig(cfg),
          noteTitle: "FPT AI Factory",
          noteMessage: [
            "FPT AI Factory exposes OpenAI-compatible chat completions.",
            "Phase 1 in OpenClaw focuses on chat and vision-capable models.",
          ].join("\n"),
          wizard: {
            choiceId: "fpt-ai-factory-api-key",
            choiceLabel: "FPT AI Factory API key",
            choiceHint: "OpenAI-compatible API key",
            groupId: "fpt-ai-factory",
            groupLabel: "FPT AI Factory",
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
              ...(await buildFptAiFactoryProvider(discoveryApiKey ?? apiKey)),
              apiKey,
            },
          };
        },
      },
    });
  },
});
