// Groq plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { groqMediaUnderstandingProvider } from "./media-understanding-provider.js";

const GROQ_DEFAULT_MODEL_REF = "groq/llama-3.3-70b-versatile";

export default definePluginEntry({
  id: "groq",
  name: "Groq Provider",
  description: "Bundled Groq provider plugin",
  register(api) {
    api.registerProvider({
      id: "groq",
      label: "Groq",
      docsPath: "/providers/groq",
      envVars: ["GROQ_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "groq",
          methodId: "api-key",
          label: "Groq API key",
          hint: "Fast OpenAI-compatible inference",
          optionKey: "groqApiKey",
          flagName: "--groq-api-key",
          envVar: "GROQ_API_KEY",
          promptMessage: "Enter Groq API key",
          defaultModel: GROQ_DEFAULT_MODEL_REF,
          wizard: {
            choiceId: "groq-api-key",
            choiceLabel: "Groq API key",
            choiceHint: "Fast OpenAI-compatible inference",
            groupId: "groq",
            groupLabel: "Groq",
            groupHint: "Fast OpenAI-compatible inference",
          },
        }),
      ],
    });
    api.registerMediaUnderstandingProvider(groqMediaUnderstandingProvider);
  },
});
