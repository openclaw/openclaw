import type {
  SearchConfigRecord,
  WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  mergeScopedSearchConfig,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search";
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-config-contract";
import { APIFY_FETCH_PROVIDER_SHARED } from "./apify-fetch-provider-shared.js";
import {
  APIFY_CREDENTIAL_LABEL,
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
} from "./apify-shared.js";

type ApifySearchRuntime = typeof import("./apify-search-runtime.js");

let apifySearchRuntimePromise: Promise<ApifySearchRuntime> | undefined;

function loadApifySearchRuntime(): Promise<ApifySearchRuntime> {
  apifySearchRuntimePromise ??= import("./apify-search-runtime.js");
  return apifySearchRuntimePromise;
}

const ApifySearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results (1-10). Default: 5.",
      minimum: 1,
      maximum: 10,
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createApifyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: APIFY_PLUGIN_ID,
    label: APIFY_SEARCH_LABEL,
    hint: APIFY_SEARCH_HINT,
    onboardingScopes: ["text-inference"],
    requiresCredential: true,
    credentialLabel: APIFY_CREDENTIAL_LABEL,
    envVars: APIFY_ENV_VARS,
    placeholder: APIFY_PLACEHOLDER,
    signupUrl: APIFY_SIGNUP_URL,
    docsUrl: APIFY_SEARCH_DOCS_URL,
    autoDetectOrder: APIFY_SEARCH_AUTO_DETECT_ORDER,
    credentialPath: APIFY_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: APIFY_CREDENTIAL_PATH,
      searchCredential: { type: "top-level" },
    }),
    getConfiguredCredentialValue: APIFY_FETCH_PROVIDER_SHARED.getConfiguredCredentialValue,
    setConfiguredCredentialValue: APIFY_FETCH_PROVIDER_SHARED.setConfiguredCredentialValue,
    createTool: (ctx) => {
      const pluginWebSearchConfig = resolveProviderWebSearchPluginConfig(
        ctx.config,
        APIFY_PLUGIN_ID,
      );
      const sharedApiKey = resolveApifyPluginApiKey(ctx.config);
      const searchConfig: SearchConfigRecord | undefined = mergeScopedSearchConfig(
        ctx.searchConfig,
        "apify",
        { ...pluginWebSearchConfig, apiKey: sharedApiKey },
        { mirrorApiKeyToTopLevel: true },
      );
      return {
        description:
          "Search the web using Apify RAG Web Browser. Returns headless-rendered pages with full markdown content — better for JS-heavy sites than pure link-list search.",
        parameters: ApifySearchSchema,
        execute: async (args) => {
          const { executeApifySearch } = await loadApifySearchRuntime();
          return executeApifySearch(args, searchConfig);
        },
      };
    },
  };
}
