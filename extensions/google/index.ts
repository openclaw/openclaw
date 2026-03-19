import { buildGoogleImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import {
  GOOGLE_GEMINI_DEFAULT_MODEL,
  applyGoogleGeminiModelDefault,
} from "openclaw/plugin-sdk/provider-models";
import { createGoogleThinkingPayloadWrapper } from "openclaw/plugin-sdk/provider-stream";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import { googleMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { isModernGoogleModel, resolveGoogle31ForwardCompatModel } from "./provider-models.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

export default definePluginEntry({
  id: "google",
  name: "Google Plugin",
  description: "Bundled Google plugin",
  register(api) {
    api.registerProvider({
      id: "google",
      label: "Google AI Studio",
      docsPath: "/providers/models",
      envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: "google",
          methodId: "api-key",
          label: "Google Gemini API key",
          hint: "AI Studio / Gemini API key",
          optionKey: "geminiApiKey",
          flagName: "--gemini-api-key",
          envVar: "GEMINI_API_KEY",
          promptMessage: "Enter Gemini API key",
          defaultModel: GOOGLE_GEMINI_DEFAULT_MODEL,
          expectedProviders: ["google"],
          applyConfig: (cfg) => applyGoogleGeminiModelDefault(cfg).next,
          wizard: {
            choiceId: "gemini-api-key",
            choiceLabel: "Google Gemini API key",
            groupId: "google",
            groupLabel: "Google",
            groupHint: "Gemini API key + OAuth",
          },
        }),
      ],
      resolveDynamicModel: (ctx) =>
        resolveGoogle31ForwardCompatModel({ providerId: "google", ctx }),
      wrapStreamFn: (ctx) => createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel),
      isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    });
    registerGoogleGeminiCliProvider(api);
    api.registerImageGenerationProvider(buildGoogleImageGenerationProvider());
    api.registerMediaUnderstandingProvider(googleMediaUnderstandingProvider);
    api.registerWebSearchProvider(createGeminiWebSearchProvider());
  },
});
