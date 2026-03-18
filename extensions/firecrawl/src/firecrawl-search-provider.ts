import { Type } from "@sinclair/typebox";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/plugin-runtime";
import { runFirecrawlSearch } from "./firecrawl-client.js";

const GenericFirecrawlSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

function getScopedCredentialValue(searchConfig?: Record<string, unknown>): unknown {
  const scoped = searchConfig?.firecrawl;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return undefined;
  }
  return (scoped as Record<string, unknown>).apiKey;
}

function setScopedCredentialValue(
  searchConfigTarget: Record<string, unknown>,
  value: unknown,
): void {
  const scoped = searchConfigTarget.firecrawl;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    searchConfigTarget.firecrawl = { apiKey: value };
    return;
  }
  (scoped as Record<string, unknown>).apiKey = value;
}

export function createFirecrawlWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "firecrawl",
    label: "Firecrawl Search",
    hint: "Structured results with optional result scraping",
    envVars: ["FIRECRAWL_API_KEY"],
    placeholder: "fc-...",
    signupUrl: "https://www.firecrawl.dev/",
    docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
    autoDetectOrder: 60,
    getCredentialValue: getScopedCredentialValue,
    setCredentialValue: setScopedCredentialValue,
    createTool: (ctx) => ({
      description:
        "Search the web using Firecrawl. Returns structured results with snippets from Firecrawl Search. Use firecrawl_search for Firecrawl-specific knobs like sources or categories.",
      parameters: GenericFirecrawlSearchSchema,
      execute: async (args) =>
        await runFirecrawlSearch({
          cfg: ctx.config,
          query: typeof args.query === "string" ? args.query : "",
          count: typeof args.count === "number" ? args.count : undefined,
        }),
    }),
  };
}
