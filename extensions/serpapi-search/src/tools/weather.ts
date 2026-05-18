import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { callSerpApi } from "../serpapi-client.js";
import { type SerpApiToolCtx, resolveToolConfig } from "../utils.js";

const ALLOWED_PARAMS = ["q", "gl", "hl", "google_domain", "zero_trace"] as const;

function extract(raw: Record<string, unknown>): Record<string, unknown> {
  const box = (raw.answer_box ?? null) as Record<string, unknown> | null;
  return {
    engine: "google_light",
    answer_box: box,
  };
}

export function createSerpApiWeatherTool(api: OpenClawPluginApi, ctx?: SerpApiToolCtx) {
  return {
    name: "serpapi_weather",
    label: "SerpApi Weather",
    description:
      "Get current weather or forecast for a location via Google (SerpApi). " +
      "Returns temperature (high/low), conditions, date, and location from Google's weather answer box. " +
      "Ask naturally, e.g. 'weather in Kyiv tomorrow' or 'weather forecast for Paris this week'.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language weather query (e.g. 'weather in Kyiv', 'weather tomorrow in Berlin', 'forecast for Tokyo this week').",
        },
        gl: {
          type: "string",
          description: "Two-letter country code for localized results (e.g. us, gb, ua).",
        },
        hl: {
          type: "string",
          description: "Two-letter language code for the response (e.g. en, de, uk).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      const cfg = resolveToolConfig(api, ctx);
      const raw = await callSerpApi({
        cfg,
        engine: "google_light",
        allowedParams: ALLOWED_PARAMS,
        params: {
          q: readStringParam(args, "query", { required: true }),
          gl: readStringParam(args, "gl") ?? undefined,
          hl: readStringParam(args, "hl") ?? undefined,
        },
        signal,
      });
      return extract(raw);
    },
  };
}
