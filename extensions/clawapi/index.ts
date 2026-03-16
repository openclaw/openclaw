import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { applyClawApiConfig, CLAWAPI_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildClawApiProvider } from "./provider-catalog.js";

const PROVIDER_ID = "clawapi";

const clawapiPlugin = {
  id: PROVIDER_ID,
  name: "ClawAPI Provider",
  description: "Bundled ClawAPI provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ClawAPI",
      docsPath: "/providers/clawapi",
      envVars: ["CLAWAPI_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "ClawAPI API key",
          hint: "Crypto-native multi-model gateway",
          optionKey: "clawapiApiKey",
          flagName: "--clawapi-api-key",
          envVar: "CLAWAPI_KEY",
          promptMessage: "Enter ClawAPI API key",
          defaultModel: CLAWAPI_DEFAULT_MODEL_REF,
          expectedProviders: ["clawapi"],
          applyConfig: (cfg) => applyClawApiConfig(cfg),
          noteMessage: [
            "ClawAPI is a crypto-native multi-model API gateway.",
            "One key gives you access to 8 models including GPT-5.4, Claude Opus 4.6, and Gemini 3.1 Pro.",
            "Get your API key at: https://clawapi.org",
          ].join("\n"),
          noteTitle: "ClawAPI",
          wizard: {
            choiceId: "clawapi-api-key",
            choiceLabel: "ClawAPI API key",
            groupId: "clawapi",
            groupLabel: "ClawAPI",
            groupHint: "Crypto-native multi-model gateway",
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
              ...buildClawApiProvider(),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default clawapiPlugin;
