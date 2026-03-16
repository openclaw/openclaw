import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildTogetherProvider } from "../../src/agents/models-config.providers.static.js";
import {
  applyTogetherConfig,
  TOGETHER_DEFAULT_MODEL_REF,
} from "../../src/commands/onboard-auth.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";

const PROVIDER_ID = "together";

const togetherPlugin = {
  id: PROVIDER_ID,
  name: "Together Provider",
  description: "Bundled Together provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Together",
      docsPath: "/providers/together",
      envVars: ["TOGETHER_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Together AI API key",
          hint: "API key",
          optionKey: "togetherApiKey",
          flagName: "--together-api-key",
          envVar: "TOGETHER_API_KEY",
          promptMessage: "Enter Together AI API key",
          defaultModel: TOGETHER_DEFAULT_MODEL_REF,
          expectedProviders: ["together"],
          applyConfig: (cfg) => applyTogetherConfig(cfg),
          wizard: {
            choiceId: "together-api-key",
            choiceLabel: "Together AI API key",
            groupId: "together",
            groupLabel: "Together AI",
            groupHint: "API key",
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
              ...buildTogetherProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default togetherPlugin;
