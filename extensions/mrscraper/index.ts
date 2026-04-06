import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createMrScraperWebFetchProvider } from "./src/mrscraper-fetch-provider.js";
import { createMrScraperFetchHtmlTool } from "./src/mrscraper-fetch-tool.js";
import { createMrScraperScrapeTool } from "./src/mrscraper-scrape-tool.js";

export default definePluginEntry({
  id: "mrscraper",
  name: "MrScraper Plugin",
  description: "Bundled MrScraper unblocker and AI scraping plugin",
  register(api) {
    api.registerWebFetchProvider(createMrScraperWebFetchProvider());
    api.registerTool(createMrScraperFetchHtmlTool(api) as AnyAgentTool);
    api.registerTool(createMrScraperScrapeTool(api) as AnyAgentTool);
  },
});
