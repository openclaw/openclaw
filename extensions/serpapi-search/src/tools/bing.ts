import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  readNumberParam,
  readStringParam,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "q",
  "cc",
  "mkt",
  "location",
  "safeSearch",
  "filters",
  "first",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const organicResults = Array.isArray(raw.organic_results)
    ? (raw.organic_results as Record<string, unknown>[])
    : [];
  return {
    engine: "bing",
    results: organicResults.map((r) => ({
      title: typeof r.title === "string" ? wrapWebContent(r.title) : (r.title ?? null),
      url: r.link ?? null,
      snippet: typeof r.snippet === "string" ? wrapWebContent(r.snippet) : (r.snippet ?? null),
    })),
    related_searches: raw.related_searches ?? [],
  };
}

export function createSerpApiBingTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_bing",
    label: "SerpApi Bing Search",
    description:
      "Search the web using Bing via SerpApi. Returns titles, URLs, and snippets. " +
      "Use mkt for locale (e.g. en-US, de-DE) or cc for country. " +
      "Useful as an alternative to Google results.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query string. Supports Bing operators: NOT, OR, site:, filetype:, near:.",
        },
        mkt: {
          type: "string",
          description:
            "Market code combining language and country (e.g. en-US, de-DE, fr-FR). Takes precedence over cc.",
        },
        cc: {
          type: "string",
          description: "2-letter ISO country code (e.g. us, de, gb). Cannot be used with mkt.",
        },
        location: {
          type: "string",
          description: "Location to originate the search from (e.g. 'Seattle, Washington').",
        },
        safeSearch: {
          type: "string",
          enum: ["Off", "Moderate", "Strict"],
          description: "SafeSearch level (default: Moderate).",
        },
        first: {
          type: "number",
          description:
            "Result offset for pagination (default: 1; use 11 for page 2, 21 for page 3, ...).",
          minimum: 1,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "bing",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          mkt: readStringParam(args, "mkt") ?? undefined,
          cc: readStringParam(args, "cc") ?? undefined,
          location: readStringParam(args, "location") ?? undefined,
          safeSearch: readStringParam(args, "safeSearch") ?? undefined,
          first: readNumberParam(args, "first", { integer: true }) ?? undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
