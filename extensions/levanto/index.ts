import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { createSageDecisionProvider } from "./decision-provider.js";

export default definePluginEntry({
  id: "levanto",
  name: "Levanto Sage",
  description: "Native typed decisions with explicit abstention.",
  register(api) {
    api.registerDecisionProvider({
      ...createSageDecisionProvider((bytes) => api.runtime.media.getImageMetadata(bytes)),
      provider: {
        label: "Levanto Sage",
        docsPath: "/providers/levanto",
        authScope: "agent",
        envVars: ["LEVANTO_API_KEY"],
        auth: [
          createProviderApiKeyAuthMethod({
            providerId: "levanto",
            methodId: "api-key",
            label: "Levanto API key",
            optionKey: "levantoApiKey",
            flagName: "--levanto-api-key",
            envVar: "LEVANTO_API_KEY",
            promptMessage: "Enter your Levanto API key",
            // Connecting credentials never changes a conversational or decision model selection.
            wizard: {
              choiceId: "levanto-api-key",
              choiceLabel: "Levanto API key",
              groupId: "levanto",
              groupLabel: "Levanto Sage",
              modelTarget: "utility",
            },
          }),
        ],
      },
    });
  },
});
