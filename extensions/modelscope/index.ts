import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildModelScopeProvider } from "../../src/agents/models-config.providers.discovery.js";
import {
  applyModelScopeConfig,
  MODELSCOPE_DEFAULT_MODEL_REF,
} from "../../src/commands/onboard-auth.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";

const PROVIDER_ID = "modelscope";

const modelscopePlugin = {
  id: PROVIDER_ID,
  name: "ModelScope Provider",
  description: "Bundled ModelScope provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ModelScope",
      docsPath: "/providers/modelscope",
      envVars: ["MODELSCOPE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "ModelScope API key",
          hint: "Inference API",
          optionKey: "modelscopeApiKey",
          flagName: "--modelscope-api-key",
          envVar: "MODELSCOPE_API_KEY",
          promptMessage: "Enter ModelScope API key",
          defaultModel: MODELSCOPE_DEFAULT_MODEL_REF,
          expectedProviders: ["modelscope"],
          applyConfig: (cfg) => applyModelScopeConfig(cfg),
          wizard: {
            choiceId: "modelscope-api-key",
            choiceLabel: "ModelScope API key",
            choiceHint: "Inference API",
            groupId: "modelscope",
            groupLabel: "ModelScope",
            groupHint: "Inference API",
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
              ...(await buildModelScopeProvider(discoveryApiKey)),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default modelscopePlugin;
