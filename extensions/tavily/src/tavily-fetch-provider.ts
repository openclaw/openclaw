import type { WebFetchProviderPlugin } from "openclaw/plugin-sdk/provider-web-fetch";
import { enablePluginInConfig } from "openclaw/plugin-sdk/provider-web-fetch";
import { runTavilyExtract } from "./tavily-client.js";
import { TAVILY_WEB_FETCH_PROVIDER_SHARED } from "./tavily-fetch-provider-shared.js";

function applyMaxChars(value: unknown, maxChars: number): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

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
        const maxChars =
          typeof args.maxChars === "number" && Number.isFinite(args.maxChars)
            ? Math.floor(args.maxChars)
            : undefined;
        const payload = await runTavilyExtract({
          cfg: config,
          urls: [url],
          format,
          extractDepth: "advanced",
        });
        if (maxChars === undefined) {
          return payload;
        }
        const rawResults = Array.isArray(payload.results) ? payload.results : [];
        const truncated = rawResults.map((r) => {
          if (!r || typeof r !== "object" || Array.isArray(r)) {
            return r;
          }
          const entry = Object.assign({}, r) as Record<string, unknown>;
          if (entry.rawContent !== undefined) {
            entry.rawContent = applyMaxChars(entry.rawContent, maxChars);
          }
          if (entry.content !== undefined) {
            entry.content = applyMaxChars(entry.content, maxChars);
          }
          return entry;
        });
        return Object.assign({}, payload, { results: truncated });
      },
    }),
  };
}
