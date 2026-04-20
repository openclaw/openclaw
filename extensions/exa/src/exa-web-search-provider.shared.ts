import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const EXA_CREDENTIAL_PATH = "plugins.entries.exa.config.webSearch.apiKey";

export function createExaWebSearchProviderBase() {
  return {
    id: "exa",
    label: "Exa Search",
    hint: "Neural + keyword search with date filters and content extraction",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Exa API key",
    envVars: ["EXA_API_KEY"],
    placeholder: "exa-...",
    signupUrl: "https://exa.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 65,
    credentialPath: EXA_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: EXA_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "exa" },
      configuredCredential: { pluginId: "exa" },
      selectionPluginId: "exa",
    }),
  };
}
