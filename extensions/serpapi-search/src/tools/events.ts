import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["q", "gl", "hl", "location", "htichips", "start", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const events = Array.isArray(raw.events_results) ? (raw.events_results as unknown[]) : [];
  return { engine: "google_events", events };
}

export function createSerpApiEventsTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_events",
    label: "SerpApi Google Events",
    description:
      "Search local events via Google Events. Returns title, date, address, and ticket links. " +
      "htichips date filter: date:today, date:tomorrow, date:week, date:weekend, date:next_week, date:month.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Event search query (e.g. "concerts in Austin").' },
        location: { type: "string", description: 'Location string (e.g. "Austin, Texas").' },
        htichips: {
          type: "string",
          description:
            "Date filter: date:today, date:tomorrow, date:week, date:weekend, date:next_week, date:month.",
        },
        gl: { type: "string", description: "Country code (e.g. us, de, ua)." },
        hl: { type: "string", description: "Language code override." },
        start: { type: "number", description: "Result offset for pagination (0, 10, 20...)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_events",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          location: readStringParam(args, "location") ?? undefined,
          htichips: readStringParam(args, "htichips") ?? undefined,
          gl: readStringParam(args, "gl") ?? undefined,
          hl: readStringParam(args, "hl") ?? undefined,
          start: readNumberParam(args, "start", { integer: true }) ?? undefined,
        },
        signal,
      });
      return jsonResult(extract(raw));
    },
  };
}
