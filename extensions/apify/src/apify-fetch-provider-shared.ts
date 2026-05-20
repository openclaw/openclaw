import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch-contract";
import {
  APIFY_CREDENTIAL_LABEL,
  APIFY_CREDENTIAL_PATH,
  APIFY_ENV_VARS,
  APIFY_PLACEHOLDER,
  APIFY_PLUGIN_ID,
  APIFY_SIGNUP_URL,
  ensureRecord,
  resolveApifyPluginApiKey,
  setApifyPluginApiKey,
} from "./apify-shared.js";

type ApifyFetchProviderSharedFields = Omit<
  WebFetchProviderPlugin,
  "applySelectionConfig" | "createTool"
>;

export const APIFY_FETCH_PROVIDER_SHARED = {
  id: APIFY_PLUGIN_ID,
  label: "Apify Website Content Crawler",
  hint: "Fetch pages with full JS rendering and anti-bot protection using Apify.",
  credentialLabel: APIFY_CREDENTIAL_LABEL,
  envVars: APIFY_ENV_VARS,
  placeholder: APIFY_PLACEHOLDER,
  signupUrl: APIFY_SIGNUP_URL,
  docsUrl: "https://apify.com/apify/website-content-crawler",
  autoDetectOrder: 50,
  credentialPath: APIFY_CREDENTIAL_PATH,
  inactiveSecretPaths: [APIFY_CREDENTIAL_PATH],
  getCredentialValue: (fetchConfig?: Record<string, unknown>) => {
    const apifyConfig = fetchConfig?.apify;
    return apifyConfig && typeof apifyConfig === "object" && !Array.isArray(apifyConfig)
      ? (apifyConfig as Record<string, unknown>).apiKey
      : undefined;
  },
  setCredentialValue: (fetchConfigTarget: Record<string, unknown>, value: unknown) => {
    const apifyConfig = ensureRecord(fetchConfigTarget, "apify");
    apifyConfig.apiKey = value;
  },
  getConfiguredCredentialValue: (config: unknown) => resolveApifyPluginApiKey(config),
  setConfiguredCredentialValue: (configTarget: unknown, value: unknown) =>
    setApifyPluginApiKey(configTarget, value),
} satisfies ApifyFetchProviderSharedFields;
