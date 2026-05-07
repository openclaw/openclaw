import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

export function createTinyFishWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.tinyfish.config.webSearch.apiKey";

  return {
    id: "tinyfish",
    label: "TinyFish Search",
    hint: "Fast web search with structured results",
    onboardingScopes: ["text-inference"],
    credentialLabel: "TinyFish API key",
    envVars: ["TINYFISH_API_KEY"],
    placeholder: "tf_live_...",
    signupUrl: "https://tinyfish.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/tinyfish",
    autoDetectOrder: 65,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: "tinyfish" },
      configuredCredential: { pluginId: "tinyfish" },
      selectionPluginId: "tinyfish",
    }),
    createTool: () => null,
  };
}
