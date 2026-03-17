import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { ensureModelAllowlistEntry } from "openclaw/plugin-sdk/provider-onboard";
import { buildDoubaoCodingProvider, buildDoubaoProvider } from "./provider-catalog.js";

const PROVIDER_ID = "volcengine";
const VOLCENGINE_DEFAULT_MODEL_REF = "volcengine-plan/ark-code-latest";

const volcenginePlugin = {
  id: PROVIDER_ID,
  name: "Volcengine Provider",
  description: "Bundled Volcengine provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Volcengine",
      docsPath: "/concepts/model-providers#volcano-engine-doubao",
      envVars: ["VOLCANO_ENGINE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Volcano Engine API key",
          hint: "API key",
          optionKey: "volcengineApiKey",
          flagName: "--volcengine-api-key",
          envVar: "VOLCANO_ENGINE_API_KEY",
          promptMessage: "Enter Volcano Engine API key",
          defaultModel: VOLCENGINE_DEFAULT_MODEL_REF,
          expectedProviders: ["volcengine"],
          applyConfig: (cfg) =>
            ensureModelAllowlistEntry({
              cfg,
              modelRef: VOLCENGINE_DEFAULT_MODEL_REF,
            }),
          wizard: {
            choiceId: "volcengine-api-key",
            choiceLabel: "Volcano Engine API key",
            groupId: "volcengine",
            groupLabel: "Volcano Engine",
            groupHint: "API key",
          },
        }),
      ],
      catalog: {
        order: "paired",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          return {
            providers: {
              volcengine: { ...buildDoubaoProvider(), apiKey },
              "volcengine-plan": { ...buildDoubaoCodingProvider(), apiKey },
            },
          };
        },
      },
    });
  },
};

export default volcenginePlugin;
