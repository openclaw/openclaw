import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";
import { SERPAPI_CREDENTIAL_PATH } from "./config.ts";

export function createSerpApiWebSearchProviderBase() {
  return {
    id: "serpapi",
    label: "SerpApi Search",
    hint: "Real-time Google and 100+ search engines via SerpApi",
    onboardingScopes: ["text-inference"] as Array<"text-inference">,
    credentialLabel: "SerpApi API key",
    envVars: ["SERPAPI_API_KEY"],
    placeholder: "serpapi-...",
    signupUrl: "https://serpapi.com/users/sign_up",
    docsUrl: "https://docs.openclaw.ai/tools/web",
    autoDetectOrder: 75,
    credentialPath: SERPAPI_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: SERPAPI_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "serpapi" },
      configuredCredential: { pluginId: "serpapi" },
      selectionPluginId: "serpapi",
    }),
  };
}
