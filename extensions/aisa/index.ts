import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyAisaConfig, AISA_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildAisaProvider } from "./provider-catalog.js";

const PROVIDER_ID = "aisa";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "AIsa Provider",
  description: "Bundled AIsa provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "AIsa",
      docsPath: "/providers/aisa",
      envVars: ["AISA_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "AIsa API key",
          hint: "China's top AI models — Qwen, Kimi, GLM, DeepSeek, MiniMax — one API key",
          optionKey: "aisaApiKey",
          flagName: "--aisa-api-key",
          envVar: "AISA_API_KEY",
          promptMessage: "Enter AIsa API key",
          defaultModel: AISA_DEFAULT_MODEL_REF,
          expectedProviders: ["aisa"],
          applyConfig: (cfg) => applyAisaConfig(cfg),
          wizard: {
            choiceId: "aisa-api-key",
            choiceLabel: "AIsa API key",
            groupId: "aisa",
            groupLabel: "AIsa",
            groupHint: "China's top AI models — Qwen, Kimi, GLM, DeepSeek, MiniMax — one API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildAisaProvider,
          }),
      },
    });
  },
});
