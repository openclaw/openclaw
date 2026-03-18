import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { buildFalImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { applyFalConfig, FAL_DEFAULT_IMAGE_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "fal";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "fal Provider",
  description: "Bundled fal image generation provider",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "fal",
      docsPath: "/providers/models",
      envVars: ["FAL_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "fal API key",
          hint: "Image generation API key",
          optionKey: "falApiKey",
          flagName: "--fal-api-key",
          envVar: "FAL_KEY",
          promptMessage: "Enter fal API key",
          defaultModel: FAL_DEFAULT_IMAGE_MODEL_REF,
          expectedProviders: ["fal"],
          applyConfig: (cfg) => applyFalConfig(cfg),
          wizard: {
            choiceId: "fal-api-key",
            choiceLabel: "fal API key",
            choiceHint: "Image generation API key",
            groupId: "fal",
            groupLabel: "fal",
            groupHint: "Image generation",
          },
        }),
      ],
    });
    api.registerImageGenerationProvider(buildFalImageGenerationProvider());
  },
});
