import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch";
import { enablePluginInConfig } from "openclaw/plugin-sdk/provider-web-fetch";
import { runFirecrawlScrape } from "./firecrawl-client.js";
import { FIRECRAWL_FREE_WEB_FETCH_PROVIDER_SHARED } from "./firecrawl-fetch-provider-shared.js";

export function createFirecrawlFreeWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...FIRECRAWL_FREE_WEB_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, "firecrawl").config,
    createTool: ({ config }) => ({
      description: "Fetch a page using Firecrawl's free keyless scrape.",
      parameters: {},
      execute: async (args) => {
        const url = typeof args.url === "string" ? args.url : "";
        const extractMode = args.extractMode === "text" ? "text" : "markdown";
        const maxChars = readPositiveIntegerParam(args, "maxChars");
        return await runFirecrawlScrape({
          cfg: config,
          keyless: true,
          url,
          extractMode,
          maxChars,
        });
      },
    }),
  };
}
