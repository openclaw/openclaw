import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildKlingaiImageGenerationProvider } from "./image-generation-provider.js";
import {
  applyKlingaiCnConfig,
  applyKlingaiGlobalConfig,
} from "./onboard.js";
import { buildKlingaiVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "klingai";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "KlingAI Provider",
  description: "Bundled KlingAI image and video generation provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "KlingAI",
      docsPath: "/providers/models",
      envVars: ["KLING_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-global",
          label: "KlingAI API key (Global)",
          hint: "Global endpoint - api-singapore.klingai.com",
          optionKey: "klingApiKey",
          flagName: "--kling-api-key",
          envVar: "KLING_API_KEY",
          promptMessage: "Enter KlingAI API key (Global)",
          expectedProviders: ["klingai"],
          applyConfig: (cfg) => applyKlingaiGlobalConfig(cfg),
          wizard: {
            choiceId: "klingai-global-api",
            choiceLabel: "KlingAI API key (Global)",
            choiceHint: "Global endpoint - api-singapore.klingai.com",
            groupId: "klingai",
            groupLabel: "KlingAI",
            groupHint: "Image and video generation",
            onboardingScopes: ["image-generation"],
          },
        }),
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-cn",
          label: "KlingAI API key (CN)",
          hint: "CN endpoint - api-beijing.klingai.com",
          optionKey: "klingApiKey",
          flagName: "--kling-api-key",
          envVar: "KLING_API_KEY",
          promptMessage: "Enter KlingAI API key (CN)",
          expectedProviders: ["klingai"],
          applyConfig: (cfg) => applyKlingaiCnConfig(cfg),
          wizard: {
            choiceId: "klingai-cn-api",
            choiceLabel: "KlingAI API key (CN)",
            choiceHint: "CN endpoint - api-beijing.klingai.com",
            groupId: "klingai",
            groupLabel: "KlingAI",
            groupHint: "Image and video generation",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerImageGenerationProvider(buildKlingaiImageGenerationProvider());
    api.registerVideoGenerationProvider(buildKlingaiVideoGenerationProvider());
  },
});
