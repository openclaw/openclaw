import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch";
import { enablePluginInConfig } from "openclaw/plugin-sdk/provider-web-fetch";
import { resolveTavilyFetchApiKey, resolveTavilyFetchBaseUrl } from "./config.js";
import { runTavilyExtract } from "./tavily-client.js";
import { TAVILY_WEB_FETCH_PROVIDER_SHARED } from "./tavily-fetch-provider-shared.js";

export function createTavilyWebFetchProvider(): WebFetchProviderPlugin {
  return {
    ...TAVILY_WEB_FETCH_PROVIDER_SHARED,
    applySelectionConfig: (config) => enablePluginInConfig(config, "tavily").config,
    createTool: ({ config }) => ({
      description: "Fetch a page using Tavily Extract.",
      parameters: {},
      execute: async (args) => {
        const url = typeof args.url === "string" ? args.url : "";
        const format = args.extractMode === "text" ? "text" : "markdown";
        const apiKey = resolveTavilyFetchApiKey(config);
        const baseUrl = resolveTavilyFetchBaseUrl(config);
        const payload = await runTavilyExtract({
          cfg: config,
          urls: [url],
          format,
          extractDepth: "advanced",
          ...(apiKey ? { apiKey } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        });
        const rawResults = Array.isArray(payload.results) ? payload.results : [];
        const first = rawResults.find(
          (r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
        );
        const text =
          (typeof first?.rawContent === "string" && first.rawContent) ||
          (typeof first?.content === "string" && first.content) ||
          "";
        const finalUrl = typeof first?.url === "string" && first.url ? first.url : url;
        const result: Record<string, unknown> = {
          url,
          finalUrl,
          extractor: "tavily",
          text,
        };
        if (typeof payload.tookMs === "number" && Number.isFinite(payload.tookMs)) {
          result.tookMs = payload.tookMs;
        }
        return result;
      },
    }),
  };
}
