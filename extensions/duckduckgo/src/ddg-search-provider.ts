import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { SearchConfigRecord } from "openclaw/plugin-sdk/provider-web-search";
import {
  createWebSearchProviderContractFields,
  WEB_SEARCH_QUERY_COUNT_PROPERTIES,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const loadDuckDuckGoClientModule = createLazyRuntimeModule(() => import("./ddg-client.js"));

const DuckDuckGoSearchSchema = {
  type: "object",
  properties: {
    ...WEB_SEARCH_QUERY_COUNT_PROPERTIES,
    region: {
      type: "string",
      description: "Optional DuckDuckGo region code such as us-en, uk-en, or de-de.",
    },
    safeSearch: {
      type: "string",
      description: "SafeSearch level: strict, moderate, or off.",
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createDuckDuckGoWebSearchProvider(): WebSearchProviderPlugin {
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
    createTool: (ctx) => ({
      description:
        "Search the web using DuckDuckGo. Returns titles, URLs, and snippets with no API key required.",
      parameters: DuckDuckGoSearchSchema,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        const { runDuckDuckGoSearch } = await loadDuckDuckGoClientModule();
        const safeSearch = readStringParam(args, "safeSearch");
        // SAFETY: tools.web.search is config-schema-validated upstream of this cast.
        const searchConfig = ctx.searchConfig as SearchConfigRecord | undefined;
        return await runDuckDuckGoSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count:
            readPositiveIntegerParam(args, "count", {
              max: 10,
              message: "count must be an integer from 1 to 10.",
            }) ?? searchConfig?.maxResults,
          timeoutSeconds: searchConfig?.timeoutSeconds,
          region: readStringParam(args, "region"),
          safeSearch:
            safeSearch === "strict" || safeSearch === "moderate" || safeSearch === "off"
              ? safeSearch
              : undefined,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
    }),
  };
}
