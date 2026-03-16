import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { buildModelStudioProvider } from "../../src/agents/models-config.providers.static.js";
import {
  applyModelStudioConfig,
  applyModelStudioConfigCn,
  MODELSTUDIO_DEFAULT_MODEL_REF,
} from "../../src/commands/onboard-auth.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";

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
          label: "中国区 Coding Plan API Key（订阅制）",
          hint: "端点：coding.dashscope.aliyuncs.com",
          optionKey: "modelstudioApiKeyCn",
          flagName: "--modelstudio-api-key-cn",
          envVar: "MODELSTUDIO_API_KEY",
          promptMessage: "输入阿里云 Model Studio Coding Plan API Key（中国区）",
          defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
          expectedProviders: ["modelstudio"],
          applyConfig: (cfg) => applyModelStudioConfigCn(cfg),
          noteMessage: [
            "获取 API Key：https://bailian.console.aliyun.com/",
            "端点：coding.dashscope.aliyuncs.com",
            "模型：qwen3.5-plus、glm-4.7、kimi-k2.5、MiniMax-M2.5 等。",
          ].join("\n"),
          noteTitle: "Alibaba Cloud Model Studio Coding Plan (China)",
          wizard: {
            choiceId: "modelstudio-api-key-cn",
            choiceLabel: "中国区 Coding Plan API Key（订阅制）",
            choiceHint: "端点：coding.dashscope.aliyuncs.com",
            groupId: "modelstudio",
            groupLabel: "Alibaba Cloud Model Studio",
            groupHint: "Coding Plan API Key（中国区 / 国际站）",
          },
        }),
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "国际站 Coding Plan API Key（订阅制）",
          hint: "端点：coding-intl.dashscope.aliyuncs.com",
          optionKey: "modelstudioApiKey",
          flagName: "--modelstudio-api-key",
          envVar: "MODELSTUDIO_API_KEY",
          promptMessage: "输入阿里云 Model Studio Coding Plan API Key（国际站）",
          defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
          expectedProviders: ["modelstudio"],
          applyConfig: (cfg) => applyModelStudioConfig(cfg),
          noteMessage: [
            "获取 API Key：https://bailian.console.aliyun.com/",
            "端点：coding-intl.dashscope.aliyuncs.com",
            "模型：qwen3.5-plus、glm-4.7、kimi-k2.5、MiniMax-M2.5 等。",
          ].join("\n"),
          noteTitle: "Alibaba Cloud Model Studio Coding Plan (Global/Intl)",
          wizard: {
            choiceId: "modelstudio-api-key",
            choiceLabel: "国际站 Coding Plan API Key（订阅制）",
            choiceHint: "端点：coding-intl.dashscope.aliyuncs.com",
            groupId: "modelstudio",
            groupLabel: "Alibaba Cloud Model Studio",
            groupHint: "Coding Plan API Key（中国区 / 国际站）",
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
