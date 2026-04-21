import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

export default definePluginEntry({
  id: "agnes-ai",
  name: "Agnes AI",
  description: "Agnes AI model provider",

  register(api) {
    api.registerProvider({
      id: "agnes-ai",
      label: "Agnes AI",
      docsPath: "/providers/agnes-ai",
      envVars: ["AGNES_API_KEY"],

      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "agnes-ai",
          methodId: "api-key",
          label: "Agnes AI API key",
          envVar: "AGNES_API_KEY",
          defaultModel: "agnes-ai/agnes-1.5-pro"
        })
      ],

      catalog: {
        models: [
          {
            id: "agnes-ai/agnes-1.5-pro",
            name: "Agnes 1.5 Pro",
            type: "text"
          }
        ]
      }
    });
  }
});
