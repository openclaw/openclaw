import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createWebSearchProviderContractFields,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search-contract";

const KEENABLE_CREDENTIAL_PATH = "plugins.entries.keenable.config.webSearch.apiKey";
const KEENABLE_SEARCH_MODES = ["pro", "realtime"] as const;
const KEENABLE_MAX_SEARCH_COUNT = 50;
const KEENABLE_MIN_SNIPPET_LENGTH = 180;
const KEENABLE_MAX_SNIPPET_LENGTH = 10_000;

const loadKeenableWebSearchRuntime = createLazyRuntimeModule(
  () => import("./keenable-web-search-provider.runtime.js"),
);

const KeenableSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Natural-language search query." },
    count: {
      type: "integer",
      description: "Number of results to return (1-50).",
      minimum: 1,
      maximum: KEENABLE_MAX_SEARCH_COUNT,
    },
    mode: {
      type: "string",
      enum: [...KEENABLE_SEARCH_MODES],
      description: 'Search mode: "pro" (default, higher quality) or "realtime" (fastest).',
    },
    site: {
      type: "string",
      description: 'Restrict results to one site (for example "techcrunch.com").',
    },
    published_after: {
      type: "string",
      description: "Only results published after this date (YYYY-MM-DD).",
    },
    published_before: {
      type: "string",
      description: "Only results published before this date (YYYY-MM-DD).",
    },
    acquired_after: {
      type: "string",
      description: "Only results indexed after this date (YYYY-MM-DD).",
    },
    acquired_before: {
      type: "string",
      description: "Only results indexed before this date (YYYY-MM-DD).",
    },
    query_time: {
      type: "string",
      description:
        "Upper time bound for point-in-time search (ISO 8601 datetime, YYYY-MM-DD, Unix epoch, or offset such as 7d).",
    },
    snippet_max_length: {
      type: "integer",
      description: "Maximum snippet length in characters (180-10000).",
      minimum: KEENABLE_MIN_SNIPPET_LENGTH,
      maximum: KEENABLE_MAX_SNIPPET_LENGTH,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createKeenableWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "keenable",
    label: "Keenable Search",
    hint: "Fast web search with rich snippets and date or site filters",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Keenable API key",
    envVars: ["KEENABLE_API_KEY"],
    placeholder: "keen_...",
    signupUrl: "https://keenable.ai/",
    docsUrl: "https://docs.openclaw.ai/tools/keenable-search",
    autoDetectOrder: 66,
    credentialPath: KEENABLE_CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: KEENABLE_CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "keenable" },
      configuredCredential: { pluginId: "keenable" },
      selectionPluginId: "keenable",
    }),
    createTool: (ctx) => ({
      description:
        "Search the web using Keenable. Supports pro and realtime modes, site and publication date filters, and configurable snippet length.",
      parameters: KeenableSearchSchema,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        const { executeKeenableWebSearchProviderTool } = await loadKeenableWebSearchRuntime();
        return await executeKeenableWebSearchProviderTool(ctx, args, context?.signal);
      },
    }),
  };
}
