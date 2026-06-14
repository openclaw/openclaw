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
  "gl",
  "hl",
  "ll",
  "location",
  "type",
  "nearby",
  "start",
  "zero_trace",
] as const;

function extract(raw: Record<string, unknown>, maxCount: number): Record<string, unknown> {
  const results = Array.isArray(raw.local_results)
    ? (raw.local_results as unknown[]).slice(0, maxCount)
    : [];
  return {
    engine: "google_maps",
    results,
    serpapi_pagination: raw.serpapi_pagination ?? null,
  };
}

export function createSerpApiMapsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_maps",
    label: "SerpApi Google Maps",
    description:
      "Find local businesses, restaurants, services, and points of interest via Google Maps. " +
      "Returns name, address, rating, reviews, hours. Use ll for GPS precision: @lat,lng,zoom.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Place or business type query." },
        ll: {
          type: "string",
          description: 'GPS coordinates @lat,lng,zoom (e.g. "@40.7128,-74.006,14z").',
        },
        location: { type: "string", description: "City or area string (e.g. 'Austin, Texas')." },
        count: {
          type: "number",
          description: "Number of results (1-20).",
          minimum: 1,
          maximum: 20,
        },
        gl: { type: "string", description: "Country code (e.g. us, de, ua)." },
        nearby: {
          type: "string",
          description:
            "Force results near this location. Recommended when query contains 'near me'.",
        },
        start: { type: "number", description: "Result offset for pagination (0, 20, 40...)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const count = readNumberParam(args, "count", { integer: true }) ?? 5;
      const ll = readStringParam(args, "ll");
      const location = readStringParam(args, "location");
      const raw = await callSerpApi({
        cfg,
        engine: "google_maps",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          type: "search",
          ll: ll ?? undefined,
          location: location ?? undefined,
          gl: readStringParam(args, "gl") ?? undefined,
          nearby: readStringParam(args, "nearby") ?? undefined,
          start: readNumberParam(args, "start", { integer: true }) ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw, count));
    },
  };
}
