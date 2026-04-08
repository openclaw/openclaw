import {
  getScopedCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

export function createPerplexityWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "perplexity",
    label: "Perplexity Search",
    hint: "Requires Perplexity API key or OpenRouter API key · structured results",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Perplexity API key",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    placeholder: "pplx-...",
    signupUrl: "https://www.perplexity.ai/settings/api",
    docsUrl: "https://docs.openclaw.ai/perplexity",
    autoDetectOrder: 50,
    credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.perplexity.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, "perplexity"),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "perplexity", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "perplexity")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "perplexity", "apiKey", value);
    },
    createTool: () => null,
  };
}
