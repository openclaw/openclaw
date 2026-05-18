import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = ["q", "gl", "hl", "tbs", "zero_trace"] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.news_results)
    ? (raw.news_results as Record<string, unknown>[])
    : [];
  return {
    engine: "google_news",
    results: results.slice(0, maxCount).map((r) => ({
      title: r.title,
      source:
        typeof r.source === "string"
          ? r.source
          : (r.source as Record<string, unknown> | undefined)?.name ?? null,
      date: r.date ?? null,
      url: r.link ?? null,
      snippet: r.snippet ?? null,
    })),
  };
}

export function createSerpApiNewsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_news",
    label: "SerpApi Google News",
    description:
      "Search Google News for recent articles. Returns headlines, sources, dates, and URLs. " +
      "tbs time filter: qdr:h (last hour), qdr:d (today), qdr:w (week), qdr:m (month).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "News search query." },
        count: { type: "number", description: "Number of results (1-10).", minimum: 1, maximum: 10 },
        tbs: {
          type: "string",
          description: "Time filter: qdr:h (hour), qdr:d (today), qdr:w (week), qdr:m (month).",
        },
        gl: { type: "string", description: "Country code (e.g. us, de, ua)." },
        hl: { type: "string", description: "Language code override (e.g. en, de, uk)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const raw = await callSerpApi({
        cfg,
        engine: "google_news",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          tbs: readStringParam(args, "tbs") ?? undefined,
          gl: readStringParam(args, "gl") ?? undefined,
          hl: readStringParam(args, "hl") ?? undefined,
        },
      });
      return extract(raw, count);
    },
  };
}

