import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Staan provider module implements model/runtime integration.
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createStaanWebSearchProviderBase } from "./staan-web-search-provider.shared.js";

// Staan serves a fixed page of 10 results and rejects any other `count`, so
// pagination is by `offset` and narrower result counts are trimmed client-side.
const STAAN_PAGE_SIZE = 10;
const STAAN_MAX_DOMAIN_FILTERS = 10;
const STAAN_MARKETS = [
  "en-gb",
  "en-us",
  "en-au",
  "en-ca",
  "en-ie",
  "en-in",
  "en-nz",
  "en-sg",
  "en-za",
  "en-fr",
  "fr-fr",
  "de-de",
] as const;
const STAAN_CONTENT_FORMATS = ["markdown", "html"] as const;

const loadStaanWebSearchRuntime = createLazyRuntimeModule(
  () => import("./staan-web-search-provider.runtime.js"),
);

const StaanSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: `Number of results to return (1-${STAAN_PAGE_SIZE}). Staan pages are fixed at ${STAAN_PAGE_SIZE}; smaller values trim the page.`,
      minimum: 1,
      maximum: STAAN_PAGE_SIZE,
    },
    offset: {
      type: "integer",
      description: `Result offset for pagination, in multiples of ${STAAN_PAGE_SIZE}.`,
      minimum: 0,
    },
    market: {
      type: "string",
      enum: [...STAAN_MARKETS],
      description: 'Market to search, e.g. "en-gb", "fr-fr", "de-de".',
    },
    extra_snippets: {
      type: "boolean",
      description:
        "Return additional relevance-scored passages per result, for grounding and RAG.",
    },
    max_snippets: {
      type: "integer",
      description: "Maximum scored passages per result when extra_snippets is set.",
      minimum: 1,
      maximum: 10,
    },
    min_score: {
      type: "number",
      description: "Drop scored passages below this relevance score (0-1).",
      minimum: 0,
      maximum: 1,
    },
    full_content: {
      type: "string",
      enum: [...STAAN_CONTENT_FORMATS],
      description: 'Fetch full page bodies as "markdown" or "html".',
    },
    include_domains: {
      type: "array",
      items: { type: "string" },
      maxItems: STAAN_MAX_DOMAIN_FILTERS,
      description: `Restrict results to these domains (max ${STAAN_MAX_DOMAIN_FILTERS}).`,
    },
    exclude_domains: {
      type: "array",
      items: { type: "string" },
      maxItems: STAAN_MAX_DOMAIN_FILTERS,
      description: `Exclude these domains from results (max ${STAAN_MAX_DOMAIN_FILTERS}).`,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createStaanWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createStaanWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using Staan, an independent European search index operated under EU jurisdiction. Supports market selection, domain filters, relevance-scored passages, and full page extraction.",
      parameters: StaanSearchSchema,
      execute: async (args, context) => {
        context?.signal?.throwIfAborted();
        const { executeStaanWebSearchProviderTool } = await loadStaanWebSearchRuntime();
        return await executeStaanWebSearchProviderTool(ctx, args, context?.signal);
      },
    }),
  };
}
