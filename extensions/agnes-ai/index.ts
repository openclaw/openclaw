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
          hint: "API key from Agnes AI dashboard",
          optionKey: "agnesAiApiKey",
          flagName: "--agnes-ai-api-key",
          envVar: "AGNES_API_KEY",
          promptMessage: "Enter your Agnes AI API key",
          defaultModel: "agnes-ai/agnes-1.5-pro",
          wizard: {
            setup: {
              title: "Agnes AI",
              description: "Use Agnes AI models via API key",
              envVars: ["AGNES_API_KEY"]
            }
          }
        })
      ]
    });
  }
});
