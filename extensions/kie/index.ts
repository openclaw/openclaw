import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildKieVideoGenerationProvider } from "./video-generation-provider.js";

export default definePluginEntry({
  id: "kie",
  name: "Kie AI Provider",
  description: "Bundled Kie AI video provider plugin",
  register(api) {
    api.registerProvider({
      id: "kie",
      label: "Kie AI",
      docsPath: "/providers/kie",
      envVars: ["KIE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "kie",
          methodId: "api-key",
          label: "Kie AI API key",
          optionKey: "kieApiKey",
          flagName: "--kie-api-key",
          envVar: "KIE_API_KEY",
          promptMessage: "Enter Kie AI API key",
          wizard: {
            choiceId: "kie-api-key",
            choiceLabel: "Kie AI API key",
            groupId: "kie",
            groupLabel: "Kie AI",
            groupHint: "Video generation",
            onboardingScopes: ["image-generation"],
          },
        }),
      ],
    });
    api.registerVideoGenerationProvider(buildKieVideoGenerationProvider());
  },
});
