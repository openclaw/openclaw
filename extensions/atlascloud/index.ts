// extensions/atlascloud/index.ts
// Plugin entrypoint. Registers Atlas Cloud as a video generation provider
// with the public Plugin SDK and exposes its api-key auth method.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  ATLASCLOUD_DEFAULT_VIDEO_MODEL_REF,
  applyAtlasCloudConfig,
} from "./onboard.js";
import { buildAtlasCloudVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "atlascloud";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Atlas Cloud Provider",
  description: "Bundled Atlas Cloud video generation provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Atlas Cloud",
      docsPath: "/providers/models",
      envVars: ["ATLASCLOUD_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "Atlas Cloud API key",
          hint: "Video generation API key",
          optionKey: "atlascloudApiKey",
          flagName: "--atlascloud-api-key",
          envVar: "ATLASCLOUD_API_KEY",
          promptMessage: "Enter Atlas Cloud API key",
          defaultModel: ATLASCLOUD_DEFAULT_VIDEO_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          applyConfig: (cfg) => applyAtlasCloudConfig(cfg),
          wizard: {
            choiceId: "atlascloud-api-key",
            choiceLabel: "Atlas Cloud API key",
            choiceHint: "Video generation API key",
            groupId: "atlascloud",
            groupLabel: "Atlas Cloud",
            groupHint: "Video generation",
            onboardingScopes: ["video-generation"],
          },
        }),
      ],
    });
    api.registerVideoGenerationProvider(buildAtlasCloudVideoGenerationProvider());
  },
});
