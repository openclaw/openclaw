import {
  getScopedCredentialValue,
  getTopLevelCredentialValue,
  resolveProviderWebSearchPluginConfig,
  setProviderWebSearchPluginConfigValue,
  setScopedCredentialValue,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createBochaWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "bocha",
    label: "Bocha Web Search",
    hint: "High quality web search · best for Chinese content",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Bocha Web Search API key",
    envVars: ["BOCHA_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://open.bocha.cn/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 12,
    credentialPath: "plugins.entries.bocha.config.webSearch.apiKey",
    inactiveSecretPaths: ["plugins.entries.bocha.config.webSearch.apiKey"],
    getCredentialValue: (searchConfig) =>
      getScopedCredentialValue(searchConfig, "bocha") ?? getTopLevelCredentialValue(searchConfig),
    setCredentialValue: (searchConfigTarget, value) =>
      setScopedCredentialValue(searchConfigTarget, "bocha", value),
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "bocha")?.apiKey,
    setConfiguredCredentialValue: (configTarget, value) => {
      setProviderWebSearchPluginConfigValue(configTarget, "bocha", "apiKey", value);
    },
    createTool: () => null,
  };
}
