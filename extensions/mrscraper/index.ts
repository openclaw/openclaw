import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createMrScraperBulkRerunAiScraperTool } from "./src/mrscraper-bulk-rerun-ai-scraper-tool.js";
import { createMrScraperBulkRerunManualScraperTool } from "./src/mrscraper-bulk-rerun-manual-scraper-tool.js";
import { createMrScraperWebFetchProvider } from "./src/mrscraper-fetch-provider.js";
import { createMrScraperFetchHtmlTool } from "./src/mrscraper-fetch-tool.js";
import { createMrScraperGetAllResultsTool } from "./src/mrscraper-get-all-results-tool.js";
import { createMrScraperGetResultByIdTool } from "./src/mrscraper-get-result-by-id-tool.js";
import { createMrScraperRerunAiScraperTool } from "./src/mrscraper-rerun-ai-scraper-tool.js";
import { createMrScraperRerunManualScraperTool } from "./src/mrscraper-rerun-manual-scraper-tool.js";
import { createMrScraperScrapeTool } from "./src/mrscraper-scrape-tool.js";

export default definePluginEntry({
  id: "mrscraper",
  name: "MrScraper Plugin",
  description: "Bundled MrScraper unblocker and AI scraping plugin",
  register(api) {
    api.registerWebFetchProvider(createMrScraperWebFetchProvider());
    api.registerTool(createMrScraperBulkRerunAiScraperTool(api) as AnyAgentTool);
    api.registerTool(createMrScraperBulkRerunManualScraperTool(api) as AnyAgentTool);
    api.registerTool(createMrScraperFetchHtmlTool(api) as AnyAgentTool);
    api.registerTool(createMrScraperGetAllResultsTool(api) as AnyAgentTool);
    api.registerTool(createMrScraperGetResultByIdTool(api) as AnyAgentTool);
    api.registerTool(createMrScraperRerunAiScraperTool(api) as AnyAgentTool);
    api.registerTool(createMrScraperRerunManualScraperTool(api) as AnyAgentTool);
    api.registerTool(createMrScraperScrapeTool(api) as AnyAgentTool);
  },
});
