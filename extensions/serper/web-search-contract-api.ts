import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

export function createSerperWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.serper.config.webSearch.apiKey";

  return {
    id: "serper",
    label: "Serper (Google Search)",
    hint: "Real Google results · country/language filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Serper API key",
    envVars: ["SERPER_API_KEY"],
    placeholder: "your-serper-api-key",
    signupUrl: "https://serper.dev",
    docsUrl: "https://docs.openclaw.ai/serper-search",
    autoDetectOrder: 15,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "top-level" },
      configuredCredential: { pluginId: "serper" },
    }),
    createTool: () => null,
  };
}
