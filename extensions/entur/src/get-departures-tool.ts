import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveEnturConfig } from "./config.js";
import { getDepartures } from "./entur-client.js";

function optionalStringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Optional(
    Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      ...options,
    }),
  );
}

const TRANSPORT_MODES = ["bus", "tram", "metro", "rail", "water", "air", "coach"] as const;

const GetDeparturesSchema = Type.Object(
  {
    stop_id: Type.Optional(
      Type.String({
        description:
          "Entur stop ID (e.g. 'NSR:StopPlace:58366'). Use entur_search_stops to find IDs. If omitted, uses configured default stop.",
      }),
    ),
    num_departures: Type.Optional(
      Type.Number({
        description: "Number of departures to return (1-50, default 10).",
        minimum: 1,
        maximum: 50,
      }),
    ),
    transport_modes: Type.Optional(
      Type.Array(
        Type.Unsafe<(typeof TRANSPORT_MODES)[number]>({
          type: "string",
          enum: [...TRANSPORT_MODES],
        }),
        { description: "Filter by transport mode(s). Omit for all modes." },
      ),
    ),
    time_range_minutes: Type.Optional(
      Type.Number({
        description: "Only show departures within this many minutes from now (default: 120).",
        minimum: 1,
        maximum: 1440,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createGetDeparturesTool(api: OpenClawPluginApi) {
  return {
    name: "entur_get_departures",
    label: "Entur Departures",
    description:
      "Get real-time departures from a Norwegian public transit stop (bus, tram, metro, train, ferry). Shows line number, destination, expected departure time, and minutes until departure.",
    parameters: GetDeparturesSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const config = resolveEnturConfig(api.config);

      const stopId = readStringParam(rawParams, "stop_id") || config.defaultStopId;
      if (!stopId) {
        throw new Error(
          "No stop_id provided and no default stop configured. Use entur_search_stops to find a stop ID, or configure plugins.entries.entur.config.defaultStopId.",
        );
      }

      const numDepartures =
        readNumberParam(rawParams, "num_departures", { integer: true }) ||
        config.defaultNumDepartures;
      const transportModes = Array.isArray(rawParams.transport_modes)
        ? (rawParams.transport_modes as string[]).filter(Boolean)
        : config.defaultTransportModes;
      const timeRangeMinutes =
        readNumberParam(rawParams, "time_range_minutes", { integer: true }) || 120;

      const result = await getDepartures(
        stopId,
        numDepartures,
        transportModes?.length ? transportModes : undefined,
        timeRangeMinutes,
        config.clientName,
      );

      return jsonResult(result);
    },
  };
}
