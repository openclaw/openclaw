import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

type DuckDuckGoWebSearchProviderBase = Omit<WebSearchProviderPlugin, "createTool">;

export function createDuckDuckGoWebSearchProviderBase(): DuckDuckGoWebSearchProviderBase {
  return {
    id: "duckduckgo",
    label: "DuckDuckGo Search (experimental)",
    hint: "Free web search fallback with no API key required",
    onboardingScopes: ["text-inference"],
    requiresCredential: false,
    envVars: [],
    placeholder: "(no key needed)",
    signupUrl: "https://duckduckgo.com/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 100,
    credentialPath: "",
    ...createWebSearchProviderContractFields({
      credentialPath: "",
      searchCredential: { type: "scoped", scopeId: "duckduckgo" },
      selectionPluginId: "duckduckgo",
    }),
  };
}
