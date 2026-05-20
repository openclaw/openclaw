import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";
import {
  APIFY_CREDENTIAL_PATH,
  APIFY_ENV_VARS,
  APIFY_PLACEHOLDER,
  APIFY_PLUGIN_ID,
  APIFY_SEARCH_AUTO_DETECT_ORDER,
  APIFY_SEARCH_DOCS_URL,
  APIFY_SEARCH_HINT,
  APIFY_SEARCH_LABEL,
  APIFY_SIGNUP_URL,
  resolveApifyPluginApiKey,
  setApifyPluginApiKey,
} from "./src/apify-shared.js";

export function createApifyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: APIFY_PLUGIN_ID,
    label: APIFY_SEARCH_LABEL,
    hint: APIFY_SEARCH_HINT,
    onboardingScopes: ["text-inference"],
    requiresCredential: true,
    envVars: APIFY_ENV_VARS,
    placeholder: APIFY_PLACEHOLDER,
    signupUrl: APIFY_SIGNUP_URL,
    docsUrl: APIFY_SEARCH_DOCS_URL,
    autoDetectOrder: APIFY_SEARCH_AUTO_DETECT_ORDER,
    credentialPath: APIFY_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: APIFY_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
      selectionPluginId: APIFY_PLUGIN_ID,
    }),
    getConfiguredCredentialValue: (config: unknown) => resolveApifyPluginApiKey(config),
    setConfiguredCredentialValue: (configTarget: unknown, value: unknown) =>
      setApifyPluginApiKey(configTarget, value),
    createTool: () => null,
  };
}
