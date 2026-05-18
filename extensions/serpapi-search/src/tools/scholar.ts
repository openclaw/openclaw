import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = ["q", "gl", "hl", "as_ylo", "as_yhi", "scisbd", "zero_trace"] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.organic_results)
    ? (raw.organic_results as unknown[]).slice(0, maxCount)
    : [];
  return { engine: "google_scholar", results };
}

export function createSerpApiScholarTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_scholar",
    label: "SerpApi Google Scholar",
    description:
      "Search Google Scholar for academic papers, research articles, and citations. Returns titles, publication info, and citation counts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Academic search query." },
        count: { type: "number", description: "Number of results (1-10).", minimum: 1, maximum: 10 },
        as_ylo: { type: "number", description: "Filter from this year (e.g. 2020)." },
        as_yhi: { type: "number", description: "Filter until this year." },
        scisbd: {
          type: "number",
          description: "Sort by date: 1 = date, 0 = relevance (default).",
          enum: [0, 1],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const raw = await callSerpApi({
        cfg,
        engine: "google_scholar",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          as_ylo: readNumberParam(args, "as_ylo", { integer: true }) ?? undefined,
          as_yhi: readNumberParam(args, "as_yhi", { integer: true }) ?? undefined,
          scisbd: readNumberParam(args, "scisbd", { integer: true }) ?? undefined,
        },
      });
      return extract(raw, count);
    },
  };
}
