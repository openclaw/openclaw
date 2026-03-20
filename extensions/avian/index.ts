import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyAvianConfig, AVIAN_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildAvianProvider } from "./provider-catalog.js";

const PROVIDER_ID = "avian";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Avian Provider",
  description: "Bundled Avian provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Avian",
      docsPath: "/providers/avian",
      envVars: ["AVIAN_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Avian API key",
          hint: "API key",
          optionKey: "avianApiKey",
          flagName: "--avian-api-key",
          envVar: "AVIAN_API_KEY",
          promptMessage: "Enter Avian API key",
          defaultModel: AVIAN_DEFAULT_MODEL_REF,
          expectedProviders: ["avian"],
          applyConfig: (cfg) => applyAvianConfig(cfg),
          noteMessage: [
            "Avian provides OpenAI-compatible access to DeepSeek, Kimi, GLM, and MiniMax models.",
            "Get your API key at: https://avian.io",
          ].join("\n"),
          noteTitle: "Avian",
          wizard: {
            choiceId: "avian-api-key",
            choiceLabel: "Avian API key",
            groupId: "avian",
            groupLabel: "Avian",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildAvianProvider,
          }),
      },
    });
  },
});
