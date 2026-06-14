import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.ts";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.ts";

const ALLOWED_PARAMS = [
  "q",
  "lat",
  "lon",
  "tripadvisor_domain",
  "ssrc",
  "offset",
  "limit",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "tripadvisor",
    places: raw.places ?? [],
    restaurants: raw.restaurants ?? [],
    hotels: raw.hotels ?? [],
    attractions: raw.attractions ?? [],
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiTripadvisorTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_tripadvisor",
    label: "SerpApi Tripadvisor Search",
    description:
      "Search Tripadvisor for destinations, hotels, restaurants, and attractions via SerpApi. " +
      "Use ssrc to filter by category. Returns place names, descriptions, ratings, and links.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g. 'Rome', 'best restaurants in Paris', 'hotels in Kyiv').",
        },
        ssrc: {
          type: "string",
          enum: ["a", "r", "A", "h", "g", "f"],
          description:
            "Filter results by category: a = All (default), r = Restaurants, A = Things to Do, h = Hotels, g = Destinations, f = Forums.",
        },
        tripadvisor_domain: {
          type: "string",
          description:
            "Tripadvisor domain to use (e.g. 'www.tripadvisor.co.uk'). Defaults to tripadvisor.com.",
        },
        lat: {
          type: "number",
          description: "GPS latitude for location-based search origin.",
        },
        lon: {
          type: "number",
          description: "GPS longitude for location-based search origin.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (default: 30, max: 100).",
          minimum: 1,
          maximum: 100,
        },
        offset: {
          type: "number",
          description:
            "Result offset for pagination (default: 0; use 30 for page 2, 60 for page 3, ...).",
          minimum: 0,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "tripadvisor",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          ssrc: readStringParam(args, "ssrc") ?? undefined,
          tripadvisor_domain: readStringParam(args, "tripadvisor_domain") ?? undefined,
          lat: readNumberParam(args, "lat") ?? undefined,
          lon: readNumberParam(args, "lon") ?? undefined,
          limit: readNumberParam(args, "limit", { integer: true }) ?? undefined,
          offset: readNumberParam(args, "offset", { integer: true }) ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
