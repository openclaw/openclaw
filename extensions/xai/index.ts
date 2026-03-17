import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-models";
import {
  createPluginBackedWebSearchProvider,
  getScopedCredentialValue,
  setScopedCredentialValue,
} from "openclaw/plugin-sdk/provider-web-search";
import { applyXaiConfig, XAI_DEFAULT_MODEL_REF } from "./onboard.js";

const PROVIDER_ID = "xai";
const XAI_MODERN_MODEL_PREFIXES = ["grok-4"] as const;

function matchesModernXaiModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return XAI_MODERN_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

const xaiPlugin = {
  id: "xai",
  name: "xAI Plugin",
  description: "Bundled xAI plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
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
    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "grok",
        label: "Grok (xAI)",
        hint: "xAI web-grounded responses",
        envVars: ["XAI_API_KEY"],
        placeholder: "xai-...",
        signupUrl: "https://console.x.ai/",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        autoDetectOrder: 30,
        getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "grok"),
        setCredentialValue: (searchConfigTarget, value) =>
          setScopedCredentialValue(searchConfigTarget, "grok", value),
      }),
    );
  },
};

export default xaiPlugin;
