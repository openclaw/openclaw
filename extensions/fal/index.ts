import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-entry";
import { buildFalImageGenerationProvider } from "./image-generation-provider.js";
import { buildFalMusicGenerationProvider } from "./music-generation-provider.js";
import { applyFalConfig } from "./onboard.js";
import {
  createFalProvider as createFalProviderContract,
  createFalAuthMethodMetadata,
} from "./provider-contract-api.js";
import { buildFalVideoGenerationProvider } from "./video-generation-provider.js";

const PROVIDER_ID = "fal";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "fal Provider",
  description: "Bundled fal image, video, and music generation provider",
  register(api) {
    api.registerProvider({
      ...createFalProviderContract(),
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          ...createFalAuthMethodMetadata(),
          optionKey: "falApiKey",
          flagName: "--fal-api-key",
          envVar: "FAL_KEY",
          promptMessage: "Enter fal API key",
          expectedProviders: ["fal"],
          applyConfig: (cfg) => applyFalConfig(cfg),
        }),
      ],
    });
    api.registerImageGenerationProvider(buildFalImageGenerationProvider());
    api.registerMusicGenerationProvider(buildFalMusicGenerationProvider());
    api.registerVideoGenerationProvider(buildFalVideoGenerationProvider());
  },
});
