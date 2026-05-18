import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../tool-utils.js";

const ALLOWED_PARAMS = [
  "q", "check_in_date", "check_out_date", "adults", "currency", "gl", "hl", "zero_trace",
] as const;

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const properties = Array.isArray(raw.properties)
    ? (raw.properties as Record<string, unknown>[])
    : [];
  return {
    engine: "google_hotels",
    properties: properties.map((h) => ({
      name: h.name,
      rate_per_night:
        (h.rate_per_night as Record<string, unknown> | undefined)?.extracted_lowest ?? null,
      overall_rating: h.overall_rating ?? null,
      hotel_class: h.hotel_class ?? null,
      link: h.link ?? null,
    })),
  };
}

export function createSerpApiHotelsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_hotels",
    label: "SerpApi Google Hotels",
    description:
      "Search hotels and accommodation via Google Hotels. Returns name, price/night, rating, class. " +
      "Defaults to tomorrow + 2 nights when dates are not provided.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Destination city or area (e.g. 'Paris, France')." },
        check_in_date: {
          type: "string",
          description: "Check-in date YYYY-MM-DD (default: tomorrow).",
        },
        check_out_date: {
          type: "string",
          description: "Check-out date YYYY-MM-DD (default: check-in + 2 nights).",
        },
        adults: { type: "string", description: "Number of adults (default: 1)." },
        currency: { type: "string", description: "Currency code (e.g. USD, EUR)." },
        gl: { type: "string", description: "Country code (e.g. us, de, ua)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_hotels",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          check_in_date: readStringParam(args, "check_in_date") ?? isoDateOffset(1),
          check_out_date: readStringParam(args, "check_out_date") ?? isoDateOffset(3),
          adults: readStringParam(args, "adults") ?? undefined,
          currency: readStringParam(args, "currency") ?? undefined,
          gl: readStringParam(args, "gl") ?? undefined,
        },
      });
      return extract(raw);
    },
  };
}
