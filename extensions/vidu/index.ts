import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { applyViduConfig, applyViduConfigCn, VIDU_DEFAULT_VIDEO_MODEL_REF } from "./onboard.js";
import { buildViduVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "vidu";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Vidu Provider",
  description: "Bundled Vidu video generation provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Vidu",
      docsPath: "/providers/vidu",
      envVars: ["VIDU_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Vidu API key (Global)",
          hint: "Endpoint: api.vidu.com",
          optionKey: "viduApiKey",
          flagName: "--vidu-api-key",
          envVar: "VIDU_API_KEY",
          promptMessage: "Enter Vidu API key (Global)",
          defaultModel: VIDU_DEFAULT_VIDEO_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyViduConfig(cfg),
          wizard: {
            choiceId: "vidu-api-key",
            choiceLabel: "Vidu API key (Global)",
            choiceHint: "Endpoint: api.vidu.com",
            groupId: "vidu",
            groupLabel: "Vidu",
            groupHint: "Video generation (Global / China)",
          },
        }),
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key-cn",
          label: "Vidu API key (China)",
          hint: "Endpoint: api.vidu.cn",
          optionKey: "viduApiKeyCn",
          flagName: "--vidu-api-key-cn",
          envVar: "VIDU_API_KEY",
          promptMessage: "Enter Vidu API key (China)",
          defaultModel: VIDU_DEFAULT_VIDEO_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyViduConfigCn(cfg),
          wizard: {
            choiceId: "vidu-api-key-cn",
            choiceLabel: "Vidu API key (China)",
            choiceHint: "Endpoint: api.vidu.cn",
            groupId: "vidu",
            groupLabel: "Vidu",
            groupHint: "Video generation (Global / China)",
          },
        }),
      ],
    });
    api.registerVideoGenerationProvider(buildViduVideoGenerationProvider());
  },
});
