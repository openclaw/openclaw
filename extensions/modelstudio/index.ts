import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import {
  applyModelStudioConfig,
  applyModelStudioConfigCn,
  MODELSTUDIO_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildModelStudioProvider } from "./provider-catalog.js";

const PROVIDER_ID = "modelstudio";

const modelStudioPlugin = {
  id: PROVIDER_ID,
  name: "Model Studio Provider",
  description: "Bundled Model Studio provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Model Studio",
      docsPath: "/providers/models",
      envVars: ["MODELSTUDIO_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key-cn",
          label: "Coding Plan API Key for China (subscription)",
          hint: "Endpoint: coding.dashscope.aliyuncs.com",
          optionKey: "modelstudioApiKeyCn",
          flagName: "--modelstudio-api-key-cn",
          envVar: "MODELSTUDIO_API_KEY",
          promptMessage: "Enter Alibaba Cloud Model Studio Coding Plan API key (China)",
          defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
          expectedProviders: ["modelstudio"],
          applyConfig: (cfg) => applyModelStudioConfigCn(cfg),
          noteMessage: [
            "Get your API key at: https://bailian.console.aliyun.com/",
            "Endpoint: coding.dashscope.aliyuncs.com",
            "Models: qwen3.5-plus, glm-4.7, kimi-k2.5, MiniMax-M2.5, etc.",
          ].join("\n"),
          noteTitle: "Alibaba Cloud Model Studio Coding Plan (China)",
          wizard: {
            choiceId: "modelstudio-api-key-cn",
            choiceLabel: "Coding Plan API Key for China (subscription)",
            choiceHint: "Endpoint: coding.dashscope.aliyuncs.com",
            groupId: "modelstudio",
            groupLabel: "Alibaba Cloud Model Studio",
            groupHint: "Coding Plan API key (CN / Global)",
          },
        }),
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Coding Plan API Key for Global/Intl (subscription)",
          hint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
          optionKey: "modelstudioApiKey",
          flagName: "--modelstudio-api-key",
          envVar: "MODELSTUDIO_API_KEY",
          promptMessage: "Enter Alibaba Cloud Model Studio Coding Plan API key (Global/Intl)",
          defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
          expectedProviders: ["modelstudio"],
          applyConfig: (cfg) => applyModelStudioConfig(cfg),
          noteMessage: [
            "Get your API key at: https://bailian.console.aliyun.com/",
            "Endpoint: coding-intl.dashscope.aliyuncs.com",
            "Models: qwen3.5-plus, glm-4.7, kimi-k2.5, MiniMax-M2.5, etc.",
          ].join("\n"),
          noteTitle: "Alibaba Cloud Model Studio Coding Plan (Global/Intl)",
          wizard: {
            choiceId: "modelstudio-api-key",
            choiceLabel: "Coding Plan API Key for Global/Intl (subscription)",
            choiceHint: "Endpoint: coding-intl.dashscope.aliyuncs.com",
            groupId: "modelstudio",
            groupLabel: "Alibaba Cloud Model Studio",
            groupHint: "Coding Plan API key (CN / Global)",
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
          const explicitProvider = ctx.config.models?.providers?.[PROVIDER_ID];
          const explicitBaseUrl =
            typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "";
          return {
            provider: {
              ...buildModelStudioProvider(),
              ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
              apiKey,
            },
          };
        },
      },
    });
  },
};

export default modelStudioPlugin;
