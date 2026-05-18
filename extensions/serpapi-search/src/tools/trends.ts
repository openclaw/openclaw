import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["q", "geo", "date", "data_type", "hl", "cat", "gprop", "region", "tz", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "google_trends",
    interest_over_time: raw.interest_over_time ?? null,
    interest_by_region: raw.interest_by_region ?? null,
    related_topics: raw.related_topics ?? null,
    related_queries: raw.related_queries ?? null,
  };
}

export function createSerpApiTrendsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_trends",
    label: "SerpApi Google Trends",
    description:
      "Get Google Trends data: interest over time, by region, related topics, or related queries. " +
      "data_type: TIMESERIES (default), GEO_MAP, GEO_MAP_0, RELATED_TOPICS, RELATED_QUERIES.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search term(s). Up to 5 comma-separated for TIMESERIES/GEO_MAP (e.g. \"coffee,tea,juice\").",
        },
        geo: { type: "string", description: "Region code (e.g. US, DE, UA). Omit for worldwide." },
        date: {
          type: "string",
          description:
            'Date range: "now 1-d", "now 7-d", "today 1-m", "today 12-m", "today 5-y" (default: "today 12-m").',
        },
        data_type: {
          type: "string",
          enum: ["TIMESERIES", "GEO_MAP", "GEO_MAP_0", "RELATED_TOPICS", "RELATED_QUERIES"],
          description: 'Trend data type (default: "TIMESERIES").',
        },
        region: {
          type: "string",
          enum: ["COUNTRY", "REGION", "DMA", "CITY"],
          description: "Region breakdown level for GEO_MAP/GEO_MAP_0 data types.",
        },
        cat: {
          type: "string",
          description: "Search category ID (default: 0 = all categories).",
        },
        gprop: {
          type: "string",
          enum: ["", "images", "news", "froogle", "youtube"],
          description: "Property filter: empty=Web (default), images, news, froogle=Shopping, youtube.",
        },
        tz: {
          type: "number",
          description: "Timezone offset in minutes (e.g. -540 for Tokyo, 420 for PDT). Default: 420.",
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
          region: readStringParam(args, "region") ?? undefined,
          cat: readStringParam(args, "cat") ?? undefined,
          gprop: readStringParam(args, "gprop") ?? undefined,
          tz: readNumberParam(args, "tz", { integer: true }) ?? undefined,
        },
      });
      return extract(raw);
    },
  };
}
