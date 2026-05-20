import {
  DEFAULT_SEARCH_COUNT,
  readNumberParam,
  readStringParam,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import type { WebSearchProviderPlugin } from "openclaw/plugin-sdk/provider-web-search-contract";
import { createSerpApiWebSearchProviderBase } from "./serpapi-search-provider.shared.js";

type SerpApiClientModule = typeof import("./serpapi-client.js");

let clientModulePromise: Promise<SerpApiClientModule> | undefined;

function loadClientModule(): Promise<SerpApiClientModule> {
  clientModulePromise ??= import("./serpapi-client.js");
  return clientModulePromise;
}

const ALLOWED_PARAMS = [
  "q",
  "gl",
  "hl",
  "lr",
  "google_domain",
  "location",
  "uule",
  "safe",
  "nfpr",
  "filter",
  "start",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const organicResults = Array.isArray(raw.organic_results)
    ? (raw.organic_results as Record<string, unknown>[])
    : [];
  return {
    engine: "google_light",
    results: organicResults.slice(0, maxCount).map((r) => ({
      title: typeof r.title === "string" ? wrapWebContent(r.title) : (r.title ?? null),
      url: r.link ?? null,
      snippet: typeof r.snippet === "string" ? wrapWebContent(r.snippet) : (r.snippet ?? null),
    })),
    related_questions: raw.related_questions ?? [],
    related_searches: raw.related_searches ?? [],
  };
}

const SerpApiGoogleLightSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query string." },
    count: {
      type: "number",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: 10,
    },
    gl: {
      type: "string",
      description: "Country code for Google Search (e.g. us, de, ua). Defaults to us.",
    },
    location: {
      type: "string",
      description:
        "Location to originate the search from (e.g. 'Austin, Texas'). Cannot be used with uule.",
    },
    uule: {
      type: "string",
      description: "Google encoded location string. Cannot be used with location.",
    },
    google_domain: {
      type: "string",
      description: "Google domain to use (e.g. google.com, google.de). Defaults to google.com.",
    },
    lr: {
      type: "string",
      description: "Limit results to specific languages (e.g. 'lang_en|lang_de').",
    },
    safe: {
      type: "string",
      enum: ["active", "off"],
      description: 'SafeSearch level: "active" or "off".',
    },
    start: {
      type: "number",
      description:
        "Result offset for pagination (0=first page, 10=second page, 20=third page, ...).",
      minimum: 0,
    },
  },
  required: ["query"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

export function createSerpApiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    ...createSerpApiWebSearchProviderBase(),
    createTool: (ctx) => ({
      description:
        "Search the web using SerpApi Google Light (fastest Google Search API). Returns titles, URLs, snippets, related questions, and related searches.",
      parameters: SerpApiGoogleLightSearchSchema,
      execute: async (args, context) => {
        const { callSerpApi: call } = await loadClientModule();
        const count = resolveSearchCount(
          readNumberParam(args, "count", { integer: true }) ?? ctx.searchConfig?.maxResults,
          DEFAULT_SEARCH_COUNT,
        );
        const location = readStringParam(args, "location") ?? undefined;
        const uule = readStringParam(args, "uule") ?? undefined;
        if (location != null && uule != null) {
          throw new Error("serpapi web_search: location and uule cannot be used together");
        }
        const raw = await call({
          cfg: ctx.config,
          engine: "google_light",
          allowedParams: ALLOWED_PARAMS,
          params: {
            q: readStringParam(args, "query", { required: true }),
            gl: readStringParam(args, "gl") ?? "us",
            location,
            uule,
            google_domain: readStringParam(args, "google_domain") ?? undefined,
            lr: readStringParam(args, "lr") ?? undefined,
            safe: readStringParam(args, "safe") ?? undefined,
            start: readNumberParam(args, "start", { integer: true }) ?? undefined,
          },
          signal: context?.signal,
          timeoutSeconds: resolveSearchTimeoutSeconds(ctx.searchConfig),
        });
        return extract(raw, count);
      },
    }),
  };
}
