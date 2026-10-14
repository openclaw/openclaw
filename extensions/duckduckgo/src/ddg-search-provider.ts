import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const loadDuckDuckGoClientModule = createLazyRuntimeModule(() => import("./ddg-client.js"));

const DuckDuckGoSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
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
        return await runDuckDuckGoSearch({
          config: ctx.config,
          query: readStringParam(args, "query", { required: true }),
          count: readPositiveIntegerParam(args, "count", {
            max: 10,
            message: "count must be an integer from 1 to 10.",
          }),
          region: readStringParam(args, "region"),
          safeSearch: readStringParam(args, "safeSearch") as
            | "strict"
            | "moderate"
            | "off"
            | undefined,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
      },
    }),
  };
}
