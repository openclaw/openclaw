import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applySyntheticConfig, SYNTHETIC_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildSyntheticProvider } from "./provider-catalog.js";

const PROVIDER_ID = "synthetic";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Synthetic Provider",
  description: "Bundled Synthetic provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Synthetic",
      docsPath: "/providers/synthetic",
      envVars: ["SYNTHETIC_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Synthetic API key",
          hint: "Anthropic-compatible (multi-model)",
          optionKey: "syntheticApiKey",
          flagName: "--synthetic-api-key",
          envVar: "SYNTHETIC_API_KEY",
          promptMessage: "Enter Synthetic API key",
          defaultModel: SYNTHETIC_DEFAULT_MODEL_REF,
          expectedProviders: ["synthetic"],
          applyConfig: (cfg) => applySyntheticConfig(cfg),
          wizard: {
            choiceId: "synthetic-api-key",
            choiceLabel: "Synthetic API key",
            groupId: "synthetic",
            groupLabel: "Synthetic",
            groupHint: "Anthropic-compatible (multi-model)",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildSyntheticProvider,
          }),
      },
    });
  },
});
