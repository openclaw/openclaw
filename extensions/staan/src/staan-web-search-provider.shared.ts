// Staan provider module implements model/runtime integration.
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

const STAAN_CREDENTIAL_PATH = "plugins.entries.staan.config.webSearch.apiKey";
const STAAN_ONBOARDING_SCOPES: Array<"text-inference"> = ["text-inference"];

export function createStaanWebSearchProviderBase() {
  return {
    id: "staan",
    label: "Staan Search",
    hint: "Independent European web index with scored passages and full-page extraction",
    onboardingScopes: [...STAAN_ONBOARDING_SCOPES],
    credentialLabel: "Staan API key",
    envVars: ["STAAN_API_KEY"],
    placeholder: "stn_...",
    signupUrl: "https://staan.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 68,
    credentialPath: STAAN_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: STAAN_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "staan" },
      configuredCredential: { pluginId: "staan" },
      selectionPluginId: "staan",
    }),
  };
}
