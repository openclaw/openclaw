import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-config-contract";

export function createZaiWebSearchProvider(): WebSearchProviderPlugin {
  const credentialPath = "plugins.entries.zai.config.webSearch.apiKey";

  return {
    id: "zai",
    label: "Z.AI Search",
    hint: "Intent-enhanced retrieval · time/domain filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Z.AI API key",
    envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
    placeholder: "zai-...",
    signupUrl: "https://z.ai/manage-apikey/apikey-list",
    docsUrl: "https://docs.z.ai/devpack/mcp/search-mcp-server",
    autoDetectOrder: 60,
    credentialPath,
    ...createWebSearchProviderContractFields({
      credentialPath,
      searchCredential: { type: "scoped", scopeId: "zai" },
      configuredCredential: { pluginId: "zai" },
    }),
    createTool: () => null,
  };
}
