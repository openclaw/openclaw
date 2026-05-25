import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.ts";
import { type SerpApiToolCtx, readBooleanArg, resolveToolConfig } from "../utils.ts";

const ALLOWED_PARAMS = [
  "q",
  "check_in_date",
  "check_out_date",
  "adults",
  "currency",
  "gl",
  "hl",
  "sort_by",
  "min_price",
  "max_price",
  "hotel_class",
  "rating",
  "vacation_rentals",
  "next_page_token",
  "zero_trace",
] as const;

function isoDateOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoDateOffsetFrom(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (isNaN(d.getTime())) return isoDateOffset(days + 1); // fallback: today + days+1
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseIsoDate(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`serpapi_hotels: ${label} must use YYYY-MM-DD format`);
  }
  const [year, month, day] = trimmed.split("-").map((p) => Number.parseInt(p, 10));
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`serpapi_hotels: ${label} must be a valid calendar date`);
  }
  return trimmed;
}

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: "google_hotels",
    properties: raw.properties ?? [],
    ads: raw.ads ?? [],
  };
}

export function createSerpApiHotelsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_hotels",
    label: "SerpApi Google Hotels",
    description:
      "Search hotels and accommodation via Google Hotels. Returns properties with price, rating, amenities, images. " +
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
        adults: { type: "number", description: "Number of adults (default: 1).", minimum: 1 },
        currency: { type: "string", description: "Currency code (e.g. USD, EUR)." },
        gl: { type: "string", description: "Country code (e.g. us, de, ua)." },
        sort_by: {
          type: "number",
          description: "Sort: 3=lowest price, 8=highest rating, 13=most reviewed.",
          enum: [3, 8, 13],
        },
        min_price: { type: "number", description: "Minimum price per night." },
        max_price: { type: "number", description: "Maximum price per night." },
        hotel_class: {
          type: "string",
          description: 'Star class filter, comma-separated (e.g. "4,5" for 4- and 5-star).',
        },
        rating: {
          type: "number",
          description: "Minimum rating: 7=3.5+, 8=4.0+, 9=4.5+.",
          enum: [7, 8, 9],
        },
        vacation_rentals: {
          type: "boolean",
          description: "Set true to search vacation rentals instead of hotels.",
        },
        next_page_token: { type: "string", description: "Token for next page of results." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const vacationRentals = readBooleanArg(args, "vacation_rentals");
      const rawCheckIn = readStringParam(args, "check_in_date");
      const rawCheckOut = readStringParam(args, "check_out_date");
      const checkIn = rawCheckIn ? parseIsoDate(rawCheckIn, "check_in_date") : isoDateOffset(1);
      const checkOut = rawCheckOut
        ? parseIsoDate(rawCheckOut, "check_out_date")
        : isoDateOffsetFrom(checkIn, 2);
      if (rawCheckIn && rawCheckOut && checkOut <= checkIn) {
        throw new Error("serpapi_hotels: check_out_date must be after check_in_date");
      }
      const raw = await callSerpApi({
        cfg,
        engine: "google_hotels",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          check_in_date: checkIn,
          check_out_date: checkOut,
          adults: readNumberParam(args, "adults", { integer: true }) ?? undefined,
          currency: readStringParam(args, "currency") ?? undefined,
          gl: readStringParam(args, "gl") ?? undefined,
          sort_by: readNumberParam(args, "sort_by", { integer: true }) ?? undefined,
          min_price: readNumberParam(args, "min_price") ?? undefined,
          max_price: readNumberParam(args, "max_price") ?? undefined,
          hotel_class: readStringParam(args, "hotel_class") ?? undefined,
          rating: readNumberParam(args, "rating", { integer: true }) ?? undefined,
          vacation_rentals: vacationRentals !== undefined ? String(vacationRentals) : undefined,
          next_page_token: readStringParam(args, "next_page_token") ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
