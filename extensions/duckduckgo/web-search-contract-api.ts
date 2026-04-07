import {
  enablePluginInConfig,
  getScopedCredentialValue,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createDuckDuckGoWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "duckduckgo",
    label: "DuckDuckGo Search (experimental)",
    hint: "Free web search fallback with no API key required",
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://duckduckgo.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 100,
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "duckduckgo"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "duckduckgo", value),
    applySelectionConfig: (config) => enablePluginInConfig(config, "duckduckgo").config,
    createTool: () => null,
  };
}
