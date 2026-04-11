import {
  enablePluginInConfig,
  getScopedCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createYouWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "you",
    label: "You.com Search",
    hint: "Web search, deep research, and content extraction",
    credentialLabel: "You.com API key",
    requiresCredential: false,
    envVars: ["YDC_API_KEY"],
    placeholder: "ydc-...",
    signupUrl: "https://you.com/platform",
    docsUrl: "https://docs.openclaw.ai/tools/you",
    onboardingScopes: ["text-inference"],
    autoDetectOrder: 80,
    credentialPath: "plugins.entries.you.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.you.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "you"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "you", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "you")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "you", "apiKey", value);
    },
    applySelectionConfig: (config) => enablePluginInConfig(config, "you").config,
    createTool: () => null,
  };
}
