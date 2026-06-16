// Firecrawl plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createFirecrawlWebFetchProvider } from "./src/firecrawl-fetch-provider.js";
import { createFirecrawlFreeWebFetchProvider } from "./src/firecrawl-free-fetch-provider.js";
import { createFirecrawlFreeWebSearchProvider } from "./src/firecrawl-free-search-provider.js";
import { createFirecrawlScrapeTool } from "./src/firecrawl-scrape-tool.js";
import { createFirecrawlWebSearchProvider } from "./src/firecrawl-search-provider.js";
import { createFirecrawlSearchTool } from "./src/firecrawl-search-tool.js";

export default definePluginEntry({
  id: "firecrawl",
  name: "Firecrawl Plugin",
  description: "Bundled Firecrawl search and scrape plugin",
  register(api) {
    api.registerWebFetchProvider(createFirecrawlFreeWebFetchProvider());
    api.registerWebFetchProvider(createFirecrawlWebFetchProvider());
    api.registerWebSearchProvider(createFirecrawlFreeWebSearchProvider());
    api.registerWebSearchProvider(createFirecrawlWebSearchProvider());
    api.registerTool(createFirecrawlSearchTool(api) as AnyAgentTool);
    api.registerTool(createFirecrawlScrapeTool(api) as AnyAgentTool);
  },
});
