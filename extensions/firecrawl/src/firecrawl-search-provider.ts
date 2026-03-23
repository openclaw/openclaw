import { Type } from "@sinclair/typebox";
import {
  createScopedPluginWebSearchCredentialAccessors,
  enablePluginInConfig,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
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

export function createFirecrawlWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "firecrawl",
    label: "Firecrawl Search",
    hint: "Structured results with optional result scraping",
    credentialLabel: "Firecrawl API key",
    envVars: ["FIRECRAWL_API_KEY"],
    placeholder: "fc-...",
    signupUrl: "https://www.firecrawl.dev/",
    docsUrl: "https://docs.openclaw.ai/tools/firecrawl",
    autoDetectOrder: 60,
    ...createScopedPluginWebSearchCredentialAccessors({ pluginId: "firecrawl" }),
    applySelectionConfig: (config) => enablePluginInConfig(config, "firecrawl").config,
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
