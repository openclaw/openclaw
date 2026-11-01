import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildLiquidDecisionProvider } from "./decision-provider.js";

export default definePluginEntry({
  id: "liquid-ai",
  name: "Liquid AI Provider",
  description: "Liquid AI native Decision provider",
  register(api) {
    api.registerProvider({
      id: "liquid-ai",
      label: "Liquid AI",
      docsPath: "/providers/liquid-ai",
      envVars: ["LIQUIDAI_API_KEY"],
      // Decision-only credentials must never select or replace a chat model.
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "liquid-ai",
          methodId: "api-key",
          label: "Liquid AI API key",
          optionKey: "liquidAiApiKey",
          flagName: "--liquid-ai-api-key",
          envVar: "LIQUIDAI_API_KEY",
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
