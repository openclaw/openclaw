import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveEnturConfig } from "./config.js";
import { searchStops } from "./entur-client.js";

const SearchStopsSchema = Type.Object(
  {
    query: Type.String({
      description: "Stop name to search for (e.g. 'Jernbanetorget', 'Majorstuen').",
    }),
    max_results: Type.Optional(
      Type.Number({
        description: "Maximum number of stops to return (1-20, default 5).",
        minimum: 1,
        maximum: 20,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createSearchStopsTool(api: OpenClawPluginApi) {
  return {
    name: "entur_search_stops",
    label: "Entur Search Stops",
    description:
      "Search for Norwegian public transit stops by name. Returns stop IDs that can be used with entur_get_departures to check real-time departures.",
    parameters: SearchStopsSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const query = readStringParam(rawParams, "query", { required: true });
      const maxResults = readNumberParam(rawParams, "max_results", { integer: true }) || 5;
      const config = resolveEnturConfig(api.config);

      const stops = await searchStops(query, maxResults, config.clientName);
      return jsonResult({ stops });
    },
  };
}
