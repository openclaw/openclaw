import { DEFAULT_CLIENT_NAME, DEFAULT_TIMEOUT_MS } from "./config.js";
import type { DepartureResult, GeocoderResponse, StopPlaceResponse, StopResult } from "./types.js";

const JOURNEY_PLANNER_URL = "https://api.entur.io/journey-planner/v3/graphql";
const GEOCODER_URL = "https://api.entur.io/geocoder/v1/autocomplete";
const GEOCODER_REVERSE_URL = "https://api.entur.io/geocoder/v1/reverse";

const DEPARTURES_QUERY = `
query GetDepartures($stopId: String!, $numDepartures: Int!, $timeRange: Int, $whiteListedModes: [TransportMode]) {
  stopPlace(id: $stopId) {
    id
    name
    estimatedCalls(
      numberOfDepartures: $numDepartures
      timeRange: $timeRange
      whiteListedModes: $whiteListedModes
    ) {
      expectedDepartureTime
      aimedDepartureTime
      realtime
      cancellation
      destinationDisplay {
        frontText
      }
      serviceJourney {
        line {
          id
          publicCode
          transportMode
        }
      }
      quay {
        id
        name
        publicCode
      }
    }
  }
}
`;

function buildHeaders(clientName: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "ET-Client-Name": clientName,
  };
}

export async function searchStops(
  query: string,
  size: number = 5,
  clientName: string = DEFAULT_CLIENT_NAME,
): Promise<StopResult[]> {
  const url = new URL(GEOCODER_URL);
  url.searchParams.set("text", query);
  url.searchParams.set("layers", "venue");
  url.searchParams.set("size", String(size));

  const response = await fetch(url.toString(), {
    headers: { "ET-Client-Name": clientName },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Entur Geocoder error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as GeocoderResponse;
  return data.features.map((f) => ({
    id: f.properties.id,
    name: f.properties.name,
    locality: f.properties.locality ?? null,
    county: f.properties.county ?? null,
    longitude: f.geometry.coordinates[0],
    latitude: f.geometry.coordinates[1],
    transportModes: f.properties.category ?? [],
  }));
}

export async function getNearbyStops(
  latitude: number,
  longitude: number,
  radiusMeters: number = 500,
  size: number = 5,
  clientName: string = DEFAULT_CLIENT_NAME,
): Promise<StopResult[]> {
  const url = new URL(GEOCODER_REVERSE_URL);
  url.searchParams.set("point.lat", String(latitude));
  url.searchParams.set("point.lon", String(longitude));
  url.searchParams.set("boundary.circle.radius", String(radiusMeters / 1000)); // km
  url.searchParams.set("layers", "venue");
  url.searchParams.set("size", String(size));

  const response = await fetch(url.toString(), {
    headers: { "ET-Client-Name": clientName },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Entur Geocoder reverse error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as GeocoderResponse;
  return data.features.map((f) => ({
    id: f.properties.id,
    name: f.properties.name,
    locality: f.properties.locality ?? null,
    county: f.properties.county ?? null,
    longitude: f.geometry.coordinates[0],
    latitude: f.geometry.coordinates[1],
    transportModes: f.properties.category ?? [],
  }));
}

export async function getDepartures(
  stopId: string,
  numDepartures: number = 10,
  transportModes?: string[],
  timeRangeMinutes: number = 120,
  clientName: string = DEFAULT_CLIENT_NAME,
): Promise<{ stop: { id: string; name: string }; departures: DepartureResult[] }> {
  const variables: Record<string, unknown> = {
    stopId,
    numDepartures,
    timeRange: timeRangeMinutes * 60,
  };
  if (transportModes?.length) {
    variables.whiteListedModes = transportModes;
  }

  const response = await fetch(JOURNEY_PLANNER_URL, {
    method: "POST",
    headers: buildHeaders(clientName),
    body: JSON.stringify({ query: DEPARTURES_QUERY, variables }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Entur Journey Planner error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as StopPlaceResponse;

  if (result.errors?.length) {
    throw new Error(`Entur GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`);
  }

  const stopPlace = result.data.stopPlace;
  if (!stopPlace) {
    throw new Error(`Stop place not found: ${stopId}`);
  }

  const now = Date.now();
  const departures: DepartureResult[] = stopPlace.estimatedCalls.map((call) => {
    const expectedMs = new Date(call.expectedDepartureTime).getTime();
    return {
      line: call.serviceJourney.line.publicCode,
      destination: call.destinationDisplay.frontText,
      transportMode: call.serviceJourney.line.transportMode,
      scheduledTime: call.aimedDepartureTime,
      expectedTime: call.expectedDepartureTime,
      minutesUntil: Math.max(0, Math.round((expectedMs - now) / 60_000)),
      realtime: call.realtime,
      cancelled: call.cancellation,
      platform: call.quay.publicCode || call.quay.name,
    };
  });

  return {
    stop: { id: stopPlace.id, name: stopPlace.name },
    departures,
  };
}

export const __testing = {
  JOURNEY_PLANNER_URL,
  GEOCODER_URL,
  GEOCODER_REVERSE_URL,
  DEPARTURES_QUERY,
};
