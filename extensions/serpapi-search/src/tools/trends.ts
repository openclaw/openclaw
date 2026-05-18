import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = ["q", "geo", "date", "data_type", "hl", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "google_trends",
    interest_over_time: raw.interest_over_time ?? null,
    interest_by_region: raw.interest_by_region ?? null,
    related_queries: raw.related_queries ?? null,
  };
}

export function createSerpApiTrendsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_trends",
    label: "SerpApi Google Trends",
    description:
      "Get Google Trends data: interest over time, by region, or related queries. " +
      "data_type: TIMESERIES (default), GEO_MAP, RELATED_QUERIES.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term to get trend data for." },
        geo: { type: "string", description: "Region code (e.g. US, DE, UA). Omit for worldwide." },
        date: {
          type: "string",
          description:
            'Date range: "now 1-d", "now 7-d", "today 1-m", "today 12-m", "today 5-y" (default: "today 12-m").',
        },
        data_type: {
          type: "string",
          enum: ["TIMESERIES", "GEO_MAP", "RELATED_QUERIES"],
          description: 'Trend data type (default: "TIMESERIES").',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_trends",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          data_type: readStringParam(args, "data_type") ?? "TIMESERIES",
          date: readStringParam(args, "date") ?? "today 12-m",
          geo: readStringParam(args, "geo") ?? undefined,
        },
      });
      return extract(raw);
    },
  };
}
