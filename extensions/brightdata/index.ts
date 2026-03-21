import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { createBrightDataBatchTools } from "./src/brightdata-batch-tools.js";
import {
  BRIGHTDATA_BROWSER_TOOL_NAMES,
  createBrightDataBrowserTools,
} from "./src/brightdata-browser-tools.js";
import { createBrightDataScrapeTool } from "./src/brightdata-scrape-tool.js";
import { createBrightDataWebSearchProvider } from "./src/brightdata-search-provider.js";
import { createBrightDataSearchTool } from "./src/brightdata-search-tool.js";
import { createBrightDataWebDataTools } from "./src/brightdata-web-data-tools.js";

export default definePluginEntry({
  id: "brightdata",
  name: "Bright Data Plugin",
  description: "Bundled Bright Data search, scrape, structured data, and browser plugin",
  register(api) {
    api.registerWebSearchProvider(createBrightDataWebSearchProvider());
    api.registerTool(createBrightDataSearchTool(api) as AnyAgentTool);
    api.registerTool(createBrightDataScrapeTool(api) as AnyAgentTool);
    for (const tool of createBrightDataBatchTools(api)) {
      api.registerTool(tool as AnyAgentTool);
    }
    api.registerTool((ctx) => createBrightDataBrowserTools(api, ctx) as AnyAgentTool[], {
      names: [...BRIGHTDATA_BROWSER_TOOL_NAMES],
    });
    for (const tool of createBrightDataWebDataTools(api)) {
      api.registerTool(tool as AnyAgentTool);
    }
  },
});
