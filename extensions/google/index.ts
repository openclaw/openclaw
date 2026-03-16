import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "../../src/agents/tools/web-search-plugin-factory.js";
import {
  GOOGLE_GEMINI_DEFAULT_MODEL,
  applyGoogleGeminiModelDefault,
} from "../../src/commands/google-gemini-model-default.js";
import { emptyPluginConfigSchema } from "../../src/plugins/config-schema.js";
import { createProviderApiKeyAuthMethod } from "../../src/plugins/provider-api-key-auth.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import { isModernGoogleModel, resolveGoogle31ForwardCompatModel } from "./provider-models.js";

const googlePlugin = {
  id: "google",
  name: "Google Plugin",
  description: "Bundled Google plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
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
      isModernModelRef: ({ modelId }) => isModernGoogleModel(modelId),
    });
    registerGoogleGeminiCliProvider(api);
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "gemini",
        label: "Gemini (Google Search)",
        hint: "Google Search grounding · AI-synthesized",
        envVars: ["GEMINI_API_KEY"],
        placeholder: "AIza...",
        signupUrl: "https://aistudio.google.com/apikey",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        autoDetectOrder: 20,
        getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "gemini"),
        setCredentialValue: (searchConfigTarget, value) =>
          setScopedCredentialValue(searchConfigTarget, "gemini", value),
      }),
    );
  },
};

export default googlePlugin;
