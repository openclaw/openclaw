import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  readNumberParam,
  readStringParam,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "p",
  "yahoo_domain",
  "vc",
  "vl",
  "b",
  "vm",
  "vs",
  "vf",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const organicResults = Array.isArray(raw.organic_results)
    ? (raw.organic_results as Record<string, unknown>[]).map((r) => ({
        position: r.position,
        title: typeof r.title === "string" ? wrapWebContent(r.title) : (r.title ?? null),
        url: r.link ?? null,
        displayed_link: r.displayed_link ?? null,
        snippet: typeof r.snippet === "string" ? wrapWebContent(r.snippet) : (r.snippet ?? null),
      }))
    : [];
  return {
    engine: "yahoo",
    results: organicResults,
    related_searches: raw.related_searches ?? null,
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiYahooTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_yahoo",
    label: "SerpApi Yahoo! Search",
    description:
      "Search the web using Yahoo! via SerpApi. Returns titles, URLs, and snippets. " +
      "Supports Yahoo operators and domain/language filtering. " +
      "Useful as an alternative to Google or Bing results.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string.",
        },
        yahoo_domain: {
          type: "string",
          description:
            "Yahoo! domain to use (e.g. 'fr' for fr.search.yahoo.com). Defaults to search.yahoo.com.",
        },
        vc: {
          type: "string",
          description: "Two-letter country code to target (e.g. us, gb, fr).",
        },
        vl: {
          type: "string",
          description:
            "Language filter in the format lang_{code} (e.g. lang_fr to search French only).",
        },
        vm: {
          type: "string",
          enum: ["r", "i", "p"],
          description: "Adult content filter: r = Strict, i = Moderate, p = Off.",
        },
        vs: {
          type: "string",
          description: "Filter results by top-level domains, comma-separated (e.g. .com,.org).",
        },
        vf: {
          type: "string",
          description: "File format filter (e.g. pdf, txt) or 'all formats'.",
        },
        b: {
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
        engine: "yahoo",
        allowedParams: ALLOWED_PARAMS,
        params: {
          p: readStringParam(args, "query", { required: true }),
          yahoo_domain: readStringParam(args, "yahoo_domain") ?? undefined,
          vc: readStringParam(args, "vc") ?? undefined,
          vl: readStringParam(args, "vl") ?? undefined,
          vm: readStringParam(args, "vm") ?? undefined,
          vs: readStringParam(args, "vs") ?? undefined,
          vf: readStringParam(args, "vf") ?? undefined,
          b: readNumberParam(args, "b", { integer: true }) ?? undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
