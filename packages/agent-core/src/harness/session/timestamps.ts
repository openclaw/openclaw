import { parseStrictTimestampStringMs } from "@openclaw/normalization-core/number-coercion";

/** Parse an ISO-like session timestamp to milliseconds. */
export function parseSessionTimestampMs(value: unknown): number | undefined {
  return parseStrictTimestampStringMs(value);
}

/** Parse a required timestamp or throw a labeled validation error. */
export function requireSessionTimestampMs(value: string, label: string): number {
  const parsed = parseSessionTimestampMs(value);
  if (parsed === undefined) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed;
}
