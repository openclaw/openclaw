import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const TAVILY_CREDENTIAL_PATH = "plugins.entries.tavily.config.webSearch.apiKey";

const loadTavilyClientModule = createLazyRuntimeModule(() => import("./tavily-client.js"));

const TAVILY_GENERIC_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-20).",
      minimum: 1,
      maximum: 20,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createTavilyWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "tavily",
    label: "Tavily Search",
    hint: "Structured results with domain filters and AI answer summaries",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Tavily API key",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://tavily.com/",
    docsUrl: "https://docs.openclaw.ai/tools/tavily",
    autoDetectOrder: 70,
    credentialPath: TAVILY_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: TAVILY_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "tavily" },
      configuredCredential: { pluginId: "tavily" },
      selectionPluginId: "tavily",
    }),
    createTool: (ctx) => ({
      description:
        "Search the web using Tavily. Returns structured results with snippets. Use tavily_search for Tavily-specific options like search depth, topic filtering, or AI answers.",
      parameters: TAVILY_GENERIC_SEARCH_SCHEMA,
      execute: async (args, executionContext) => {
        executionContext?.signal?.throwIfAborted();
        const { runTavilySearch } = await loadTavilyClientModule();
        return await runTavilySearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          maxResults: readPositiveIntegerParam(args, "count", {
            message: "count must be an integer from 1 to 20",
            max: 20,
          }),
          ...(executionContext?.signal ? { signal: executionContext.signal } : {}),
        });
      },
    }),
  };
}
