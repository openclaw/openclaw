import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readNumberParam } from "openclaw/plugin-sdk/provider-web-search";
import { resolveEnturConfig } from "./config.js";
import { getNearbyStops } from "./entur-client.js";

const GetNearbyStopsSchema = Type.Object(
  {
    latitude: Type.Number({ description: "Latitude coordinate." }),
    longitude: Type.Number({ description: "Longitude coordinate." }),
    radius_meters: Type.Optional(
      Type.Number({
        description: "Search radius in meters (default 500, max 2000).",
        minimum: 50,
        maximum: 2000,
      }),
    ),
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

export function createGetNearbyStopsTool(api: OpenClawPluginApi) {
  return {
    name: "entur_get_nearby_stops",
    label: "Entur Nearby Stops",
    description:
      "Find Norwegian public transit stops near GPS coordinates. Returns stop IDs that can be used with entur_get_departures.",
    parameters: GetNearbyStopsSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const config = resolveEnturConfig(api.config);

      const latitude = rawParams.latitude as number;
      const longitude = rawParams.longitude as number;
      const radiusMeters = readNumberParam(rawParams, "radius_meters", { integer: true }) || 500;
      const maxResults = readNumberParam(rawParams, "max_results", { integer: true }) || 5;

      const stops = await getNearbyStops(
        latitude,
        longitude,
        radiusMeters,
        maxResults,
        config.clientName,
      );

      return jsonResult({ stops });
    },
  };
}
