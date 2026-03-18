import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-models";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { createGrokWebSearchProvider } from "./src/grok-web-search-provider.js";

const PROVIDER_ID = "xai";
const XAI_MODERN_MODEL_PREFIXES = ["grok-4"] as const;

function matchesModernXaiModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return XAI_MODERN_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export default definePluginEntry({
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "xAI",
      docsPath: "/providers/models",
      envVars: ["XAI_API_KEY"],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: "xAI API key",
          hint: "API key",
          optionKey: "xaiApiKey",
          flagName: "--xai-api-key",
          envVar: "XAI_API_KEY",
          promptMessage: "Enter xAI API key",
          defaultModel: XAI_DEFAULT_MODEL_REF,
          expectedProviders: ["xai"],
          applyConfig: (cfg) => applyXaiConfig(cfg),
          wizard: {
            choiceId: "xai-api-key",
            choiceLabel: "xAI API key",
            groupId: "xai",
            groupLabel: "xAI (Grok)",
            groupHint: "API key",
          },
        }),
      ],
      isModernModelRef: ({ provider, modelId }) =>
        normalizeProviderId(provider) === "xai" ? matchesModernXaiModel(modelId) : undefined,
    });
    api.registerWebSearchProvider(createGrokWebSearchProvider());
  },
});
