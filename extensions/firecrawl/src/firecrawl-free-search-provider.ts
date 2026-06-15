import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { buildFirecrawlFreeWebSearchProviderBase } from "../web-search-shared.js";

type FirecrawlClientModule = typeof import("./firecrawl-client.js");

let firecrawlClientModulePromise: Promise<FirecrawlClientModule> | undefined;

function loadFirecrawlClientModule(): Promise<FirecrawlClientModule> {
  firecrawlClientModulePromise ??= import("./firecrawl-client.js");
  return firecrawlClientModulePromise;
}

const GenericFirecrawlSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
  },
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createFirecrawlFreeWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...buildFirecrawlFreeWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using Firecrawl's free Search API (no API key). Returns structured results with snippets. Use firecrawl_search for Firecrawl-specific knobs like sources or categories.",
      parameters: GenericFirecrawlSearchSchema,
      execute: async (args) => {
        const { runFirecrawlSearch } = await loadFirecrawlClientModule();
        return await runFirecrawlSearch({
          cfg: ctx.config,
          keyless: true,
          query: typeof args.query === "string" ? args.query : "",
          count: readPositiveIntegerParam(args, "count", {
            message: "count must be an integer from 1 to 10",
            max: 10,
          }),
        });
      },
    }),
  };
}
