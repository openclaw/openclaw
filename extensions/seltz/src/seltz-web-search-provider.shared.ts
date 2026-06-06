import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const SELTZ_CREDENTIAL_PATH = "plugins.entries.seltz.config.webSearch.apiKey";
const SELTZ_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];

export function createSeltzWebSearchProviderBase() {
  return {
    id: "seltz",
    label: "Seltz Search",
    hint: "Context-engineered web documents for AI reasoning",
    onboardingScopes: [...SELTZ_ONBOARDING_SCOPES],
    credentialLabel: "Seltz API key",
    envVars: ["SELTZ_API_KEY"],
    placeholder: "your-api-key",
    signupUrl: "https://console.seltz.ai",
    docsUrl: "https://docs.openclaw.ai/tools/seltz-search",
    autoDetectOrder: 80,
    credentialPath: SELTZ_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: SELTZ_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "seltz" },
      configuredCredential: { pluginId: "seltz" },
      selectionPluginId: "seltz",
    }),
  };
}
