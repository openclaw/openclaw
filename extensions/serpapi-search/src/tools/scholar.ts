import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = [
  "q", "hl", "lr", "as_ylo", "as_yhi", "scisbd",
  "cites", "cluster", "as_sdt", "start", "num", "zero_trace",
] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.organic_results)
    ? (raw.organic_results as unknown[]).slice(0, maxCount)
    : [];
  return {
    engine: "google_scholar",
    results,
    related_searches: raw.related_searches ?? [],
  };
}

export function createSerpApiScholarTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_scholar",
    label: "SerpApi Google Scholar",
    description:
      "Search Google Scholar for academic papers, research articles, and citations. " +
      "Use cites=<result_id> for Cited By search, cluster=<result_id> for All Versions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Academic search query. Optional when using cites or cluster." },
        count: { type: "number", description: "Number of results (1-20).", minimum: 1, maximum: 20 },
        as_ylo: { type: "number", description: "Filter from this year (e.g. 2020)." },
        as_yhi: { type: "number", description: "Filter until this year." },
        scisbd: {
          type: "number",
          description: "Sort by date: 1=date, 0=relevance (default).",
          enum: [0, 1],
        },
        cites: { type: "string", description: "Article ID to find citing papers (Cited By search)." },
        cluster: { type: "string", description: "Article ID to find all versions. Cannot use with q+cites." },
        as_sdt: {
          type: "string",
          description: "Search type: 0=exclude patents (default), 7=include patents, 4=case law (US).",
        },
        lr: {
          type: "string",
          description: "Language restriction, pipe-separated (e.g. \"lang_en|lang_de\").",
        },
        start: { type: "number", description: "Result offset for pagination (0, 10, 20...)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const raw = await callSerpApi({
        cfg,
        engine: "google_scholar",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query"),
          as_ylo: readNumberParam(args, "as_ylo", { integer: true }) ?? undefined,
          as_yhi: readNumberParam(args, "as_yhi", { integer: true }) ?? undefined,
          scisbd: readNumberParam(args, "scisbd", { integer: true }) ?? undefined,
          cites: readStringParam(args, "cites") ?? undefined,
          cluster: readStringParam(args, "cluster") ?? undefined,
          as_sdt: readStringParam(args, "as_sdt") ?? undefined,
          lr: readStringParam(args, "lr") ?? undefined,
          start: readNumberParam(args, "start", { integer: true }) ?? undefined,
          num: count,
        },
        signal,
      });
      return extract(raw, count);
    },
  };
}
