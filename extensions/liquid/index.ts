import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildLiquidDecisionProvider } from "./decision-provider.js";

export default definePluginEntry({
  id: "liquid",
  name: "Liquid AI Provider",
  description: "Liquid AI native Decision provider",
  register(api) {
    api.registerProvider({
      id: "liquid",
      label: "Liquid AI",
      docsPath: "/providers/liquid",
      envVars: ["LIQUID_API_KEY"],
      // Decision-only credentials must never select or replace a chat model.
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "liquid",
          methodId: "api-key",
          label: "Liquid AI API key",
          optionKey: "liquidApiKey",
          flagName: "--liquid-api-key",
          envVar: "LIQUID_API_KEY",
          promptMessage: "Enter Liquid AI API key",
        }),
      ],
    });
    api.registerDecisionProvider(
      buildLiquidDecisionProvider({
        getImageMetadata: (buffer) => api.runtime.media.getImageMetadata(buffer),
      }),
    );
  },
});
