import {
  formatLocationText,
  toLocationContext,
  type NormalizedLocation,
} from "openclaw/plugin-sdk/channel-inbound";
import { parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { LocationMessageEventContent } from "../sdk.js";
import { EventType } from "./types.js";

export type MatrixLocationPayload = {
  text: string;
  context: ReturnType<typeof toLocationContext>;
};

function decodeGeoUriParamValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveMatrixLocation(params: {
  eventType: string;
  content: LocationMessageEventContent;
}): MatrixLocationPayload | null {
  const { eventType, content } = params;
  const isLocation =
    eventType === EventType.Location ||
    (eventType === EventType.RoomMessage && content.msgtype === EventType.Location);
  if (!isLocation) {
    return null;
  }
  const geoUri = normalizeOptionalString(content.geo_uri) ?? "";
  if (!geoUri) {
    return null;
  }
  if (!geoUri.toLowerCase().startsWith("geo:")) {
    return null;
  }
  const payload = geoUri.slice(4);
  const [coordsPart, ...paramParts] = payload.split(";");
  if (!coordsPart) {
    return null;
  }
  const coords = coordsPart.split(",");
  if (coords.length < 2) {
    return null;
  }
  const latitude = parseStrictFiniteNumber(coords[0] ?? "");
  const longitude = parseStrictFiniteNumber(coords[1] ?? "");
  if (latitude === undefined || longitude === undefined) {
    return null;
  }

  const geoParams = new Map<string, string>();
  for (const part of paramParts) {
    const segment = part.trim();
    if (!segment) {
      continue;
    }
    const eqIndex = segment.indexOf("=");
    const rawKey = eqIndex === -1 ? segment : segment.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? "" : segment.slice(eqIndex + 1);
    const key = normalizeLowercaseStringOrEmpty(rawKey);
    if (!key) {
      continue;
    }
    const valuePart = rawValue.trim();
    geoParams.set(key, valuePart ? decodeGeoUriParamValue(valuePart) : "");
  }

  const accuracyRaw = geoParams.get("u");
  const accuracy = accuracyRaw ? parseStrictFiniteNumber(accuracyRaw) : undefined;

  const caption = normalizeOptionalString(content.body) ?? "";
  const location: NormalizedLocation = {
    latitude,
    longitude,
    accuracy,
    caption: caption || undefined,
    source: "pin",
    isLive: false,
  };

  return {
    text: formatLocationText(location),
    context: toLocationContext(location),
  };
}
