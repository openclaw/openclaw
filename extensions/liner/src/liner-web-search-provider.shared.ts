import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const LINER_CREDENTIAL_PATH = "plugins.entries.liner.config.webSearch.apiKey";
const LINER_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];

export function createLinerWebSearchProviderBase() {
  return {
    id: "liner",
    label: "Liner Search",
    hint: "Source-grounded AI search results with per-result excerpts",
    onboardingScopes: [...LINER_ONBOARDING_SCOPES],
    credentialLabel: "Liner API key",
    envVars: ["LINER_API_KEY"],
    placeholder: "sk_live_...",
    signupUrl: "https://platform.liner.com",
    docsUrl: "https://docs.openclaw.ai/tools/liner-search",
    autoDetectOrder: 80,
    credentialPath: LINER_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: LINER_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "liner" },
      configuredCredential: { pluginId: "liner" },
      selectionPluginId: "liner",
    }),
  };
}
