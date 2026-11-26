import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GoogleMeetMode, GoogleMeetModeInput, GoogleMeetTransport } from "./config.js";

export class InvalidGoogleMeetRequest extends Error {}

export function normalizeTransport(value: unknown): GoogleMeetTransport | undefined {
  return value === "chrome" || value === "chrome-node" || value === "twilio" ? value : undefined;
}

export function normalizeMode(value: unknown): GoogleMeetMode | undefined {
  if (value === "realtime") {
    return "agent";
  }
  return value === "agent" || value === "bidi" || value === "transcribe" ? value : undefined;
}

function requireChoice<T>(value: unknown, parsed: T | undefined, expected: string): T | undefined {
  if (value !== undefined && parsed === undefined) {
    throw new InvalidGoogleMeetRequest(
      `${expected}; received ${typeof value === "string" ? value : typeof value}`,
    );
  }
  return parsed;
}

export function parseGoogleMeetMode(value: unknown): GoogleMeetModeInput | undefined {
  return requireChoice(
    value,
    value === "realtime" ? value : normalizeMode(value),
    "mode must be agent, bidi, transcribe, or realtime",
  );
}

export function parseGoogleMeetTransport(value: unknown): GoogleMeetTransport | undefined {
  return requireChoice(
    value,
    normalizeTransport(value),
    "transport must be chrome, chrome-node, or twilio",
  );
}

export function parseGoogleMeetJoinRoute(raw: Record<string, unknown>) {
  return {
    transport: parseGoogleMeetTransport(raw.transport),
    mode: parseGoogleMeetMode(raw.mode),
  };
}

export function readGoogleMeetJoinOptions(
  raw: Record<string, unknown>,
  route = parseGoogleMeetJoinRoute(raw),
) {
  return {
    ...route,
    message: normalizeOptionalString(raw.message),
    dialInNumber: normalizeOptionalString(raw.dialInNumber),
    pin: normalizeOptionalString(raw.pin),
    dtmfSequence: normalizeOptionalString(raw.dtmfSequence),
    requesterSessionKey: normalizeOptionalString(raw.requesterSessionKey),
    agentId: normalizeOptionalString(raw.agentId),
  };
}
