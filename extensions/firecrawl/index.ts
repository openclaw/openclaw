// Firecrawl plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createFirecrawlWebFetchProvider } from "./src/firecrawl-fetch-provider.js";
import { createFirecrawlFreeWebSearchProvider } from "./src/firecrawl-free-search-provider.js";
import { createFirecrawlScrapeTool } from "./src/firecrawl-scrape-tool.js";
import { createFirecrawlWebSearchProvider } from "./src/firecrawl-search-provider.js";
import { createFirecrawlSearchTool } from "./src/firecrawl-search-tool.js";

export default definePluginEntry({
  id: "firecrawl",
  name: "FireCrawl",
  description:
    "Search the live web for fresh results, scrape pages into LLM-ready Markdown, and interact with dynamic sites to extract hard-to-reach data.",
  register(api) {
    api.registerWebFetchProvider(createFirecrawlWebFetchProvider());
    api.registerWebSearchProvider(createFirecrawlWebSearchProvider());
    api.registerWebSearchProvider(createFirecrawlFreeWebSearchProvider());
    api.registerTool(createFirecrawlSearchTool(api) as AnyAgentTool);
    api.registerTool(createFirecrawlScrapeTool(api) as AnyAgentTool);
  },
});
