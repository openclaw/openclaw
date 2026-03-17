import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import { applySyntheticConfig, SYNTHETIC_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildSyntheticProvider } from "./provider-catalog.js";

const PROVIDER_ID = "synthetic";

const syntheticPlugin = {
  id: PROVIDER_ID,
  name: "Synthetic Provider",
  description: "Bundled Synthetic provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
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
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...buildSyntheticProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default syntheticPlugin;
