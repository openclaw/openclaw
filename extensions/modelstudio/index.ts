import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { buildSingleProviderApiKeyCatalog } from "openclaw/plugin-sdk/provider-catalog";
import {
  applyModelStudioConfig,
  applyModelStudioConfigCn,
  applyModelStudioStandardConfig,
  applyModelStudioStandardConfigCn,
  MODELSTUDIO_DEFAULT_MODEL_REF,
} from "./onboard.js";
import { buildModelStudioProvider } from "./provider-catalog.js";

const PROVIDER_ID = "modelstudio";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Model Studio Provider",
  description: "Bundled Model Studio provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Model Studio",
      docsPath: "/providers/models",
      envVars: ["MODELSTUDIO_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "standard-api-key-cn",
          label: "Standard API Key for China (pay-as-you-go)",
          hint: "Endpoint: dashscope.aliyuncs.com",
          optionKey: "modelstudioStandardApiKeyCn",
          flagName: "--modelstudio-standard-api-key-cn",
          envVar: "MODELSTUDIO_API_KEY",
          profileId: "modelstudio:standard-cn",
          promptMessage: "Enter Alibaba Cloud Model Studio API key (China)",
          defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
          expectedProviders: ["modelstudio"],
          applyConfig: (cfg) => applyModelStudioStandardConfigCn(cfg),
          noteMessage: [
            "Get your API key at: https://bailian.console.aliyun.com/",
            "Endpoint: dashscope.aliyuncs.com/compatible-mode/v1",
            "Models: qwen3.5-plus, qwen3.5-flash, qwen3-coder-plus, etc.",
          ].join("\n"),
          noteTitle: "Alibaba Cloud Model Studio Standard (China)",
          wizard: {
            choiceId: "modelstudio-standard-api-key-cn",
            choiceLabel: "Standard API Key for China (pay-as-you-go)",
            choiceHint: "Endpoint: dashscope.aliyuncs.com",
            groupId: "modelstudio",
            groupLabel: "Qwen (Alibaba Cloud Model Studio)",
            groupHint: "Standard / Coding Plan (CN / Global)",
          },
        }),
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "standard-api-key",
          label: "Standard API Key for Global/Intl (pay-as-you-go)",
          hint: "Endpoint: dashscope-intl.aliyuncs.com",
          optionKey: "modelstudioStandardApiKey",
          flagName: "--modelstudio-standard-api-key",
          envVar: "MODELSTUDIO_API_KEY",
          profileId: "modelstudio:standard",
          promptMessage: "Enter Alibaba Cloud Model Studio API key (Global/Intl)",
          defaultModel: MODELSTUDIO_DEFAULT_MODEL_REF,
          expectedProviders: ["modelstudio"],
          applyConfig: (cfg) => applyModelStudioStandardConfig(cfg),
          noteMessage: [
            "Get your API key at: https://modelstudio.console.alibabacloud.com/",
            "Endpoint: dashscope-intl.aliyuncs.com/compatible-mode/v1",
            "Models: qwen3.5-plus, qwen3.5-flash, qwen3-coder-plus, etc.",
          ].join("\n"),
          noteTitle: "Alibaba Cloud Model Studio Standard (Global/Intl)",
          wizard: {
            choiceId: "modelstudio-standard-api-key",
            choiceLabel: "Standard API Key for Global/Intl (pay-as-you-go)",
            choiceHint: "Endpoint: dashscope-intl.aliyuncs.com",
            groupId: "modelstudio",
            groupLabel: "Qwen (Alibaba Cloud Model Studio)",
            groupHint: "Standard / Coding Plan (CN / Global)",
          },
        }),
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
            groupLabel: "Qwen (Alibaba Cloud Model Studio)",
            groupHint: "Standard / Coding Plan (CN / Global)",
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
            groupLabel: "Qwen (Alibaba Cloud Model Studio)",
            groupHint: "Standard / Coding Plan (CN / Global)",
          },
        }),
      ],
      catalog: {
        order: "simple",
        run: (ctx) =>
          buildSingleProviderApiKeyCatalog({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildModelStudioProvider,
            allowExplicitBaseUrl: true,
          }),
      },
    });
  },
});
