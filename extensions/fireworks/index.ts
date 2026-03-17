import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildFireworksProvider } from "../../src/agents/models-config.providers.discovery.js";
import {
  applyFireworksConfig,
  FIREWORKS_DEFAULT_MODEL_REF,
} from "../../src/commands/onboard-auth.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";

const PROVIDER_ID = "fireworks";

const fireworksPlugin = {
  id: PROVIDER_ID,
  name: "Fireworks Provider",
  description: "Bundled Fireworks provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Fireworks AI",
      docsPath: "/providers/fireworks",
      envVars: ["FIREWORKS_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Fireworks AI API key",
          hint: "US-based fast inference (DeepSeek, Qwen, Llama, and more)",
          optionKey: "fireworksApiKey",
          flagName: "--fireworks-api-key",
          envVar: "FIREWORKS_API_KEY",
          promptMessage: "Enter Fireworks AI API key",
          defaultModel: FIREWORKS_DEFAULT_MODEL_REF,
          expectedProviders: ["fireworks"],
          applyConfig: (cfg) => applyFireworksConfig(cfg),
          noteMessage: [
            "Fireworks AI provides fast serverless inference for open models.",
            "Get your API key at: https://fireworks.ai/account/api-keys",
            "Supports DeepSeek, Qwen, Llama, and many more models.",
          ].join("\n"),
          noteTitle: "Fireworks AI",
          wizard: {
            choiceId: "fireworks-api-key",
            choiceLabel: "Fireworks AI API key",
            groupId: "fireworks",
            groupLabel: "Fireworks AI",
            groupHint: "US-based fast inference (DeepSeek, Qwen, Llama)",
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
              ...buildFireworksProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default fireworksPlugin;
