import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  readNumberParam,
  readStringParam,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, readBooleanArg, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "q",
  "kl",
  "safe",
  "df",
  "m",
  "start",
  "search_assist",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const organicResults = Array.isArray(raw.organic_results)
    ? (raw.organic_results as Record<string, unknown>[])
    : [];
  const kg = raw.knowledge_graph as Record<string, unknown> | undefined;
  return {
    engine: "duckduckgo",
    results: organicResults.map((r) => ({
      title: typeof r.title === "string" ? wrapWebContent(r.title) : (r.title ?? null),
      url: r.link ?? null,
      snippet: typeof r.snippet === "string" ? wrapWebContent(r.snippet) : (r.snippet ?? null),
    })),
    knowledge_graph: kg
      ? {
          title: typeof kg.title === "string" ? wrapWebContent(kg.title) : (kg.title ?? null),
          description:
            typeof kg.description === "string"
              ? wrapWebContent(kg.description)
              : (kg.description ?? null),
          website: kg.website ?? null,
          facts: kg.facts ?? null,
        }
      : null,
    news_results: raw.news_results ?? [],
    related_searches: raw.related_searches ?? [],
    search_assist: raw.search_assist ?? null,
  };
}

export function createSerpApiDuckDuckGoTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_duckduckgo",
    label: "SerpApi DuckDuckGo Search",
    description:
      "Search the web using DuckDuckGo via SerpApi. Returns organic results, knowledge graph, and news. " +
      "Privacy-focused alternative to Google/Bing. Use kl for region (e.g. us-en, de-de, uk-en). " +
      "Use df to filter by date: d=past day, w=past week, m=past month, y=past year.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query. Supports DDG operators: site:, intitle:, inurl:, filetype:.",
        },
        kl: {
          type: "string",
          description:
            "Region code (e.g. us-en, uk-en, de-de, fr-fr). Controls language and region of results.",
        },
        safe: {
          type: "number",
          enum: [1, -1, -2],
          description: "SafeSearch: 1=Strict, -1=Moderate (default), -2=Off.",
        },
        df: {
          type: "string",
          description:
            "Date filter: d=past day, w=past week, m=past month, y=past year, or custom range '2024-01-01..2024-12-31'.",
        },
        m: {
          type: "number",
          description:
            "Maximum results to return (1–50, default: 50). Cannot be used with search_assist.",
          minimum: 1,
          maximum: 50,
        },
        start: {
          type: "number",
          description:
            "Result offset for pagination (default: 0). First page returns up to 35 results; subsequent pages up to 50.",
          minimum: 0,
        },
        search_assist: {
          type: "boolean",
          description:
            "Include DuckDuckGo AI Search Assist answer in the response. Cannot be used with m.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const searchAssist = readBooleanArg(args, "search_assist");
      const searchAssistParam = searchAssist === true ? "true" : undefined;
      const m = readNumberParam(args, "m", { integer: true });
      if (searchAssist === true && m != null) {
        throw new Error("serpapi_duckduckgo: search_assist and m are mutually exclusive");
      }
      const raw = await callSerpApi({
        cfg,
        engine: "duckduckgo",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          kl: readStringParam(args, "kl") ?? undefined,
          safe: readNumberParam(args, "safe", { integer: true }) ?? undefined,
          df: readStringParam(args, "df") ?? undefined,
          m: m ?? undefined,
          start: readNumberParam(args, "start", { integer: true }) ?? undefined,
          search_assist: searchAssistParam,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
