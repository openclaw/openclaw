import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import { applyErnieConfig, ERNIE_DEFAULT_MODEL_REF } from "./onboard.js";
import { buildErnieProvider } from "./provider-catalog.js";

const PROVIDER_ID = "ernie";

const erniePlugin = {
  id: PROVIDER_ID,
  name: "ERNIE Provider",
  description: "Bundled ERNIE provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ERNIE",
      docsPath: "/providers/ernie",
      envVars: ["ERNIE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "ERNIE API key (Baidu Wenxin)",
          hint: "Qianfan API for ERNIE models",
          optionKey: "ernieApiKey",
          flagName: "--ernie-api-key",
          envVar: "ERNIE_API_KEY",
          promptMessage: "Enter ERNIE API key",
          defaultModel: ERNIE_DEFAULT_MODEL_REF,
          expectedProviders: ["ernie"],
          applyConfig: (cfg) => applyErnieConfig(cfg),
          wizard: {
            choiceId: "ernie-api-key",
            choiceLabel: "ERNIE API key (Baidu Wenxin)",
            groupId: "ernie",
            groupLabel: "ERNIE",
            groupHint: "Qianfan API for ERNIE models",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildErnieProvider,
          }),
      },
    });
  },
};

export default erniePlugin;
