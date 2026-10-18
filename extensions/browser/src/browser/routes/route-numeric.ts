import {
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeBrowserTimerDelayMs } from "../timer-delay.js";

function routeNumberReader(parse: (value: unknown) => number | undefined, description: string) {
  return (
    value: unknown,
    fieldName: string,
    options?: { invalidMessage?: string },
  ): number | undefined => {
    const parsed = parse(value);
    if (parsed === undefined && value != null) {
      throw new Error(options?.invalidMessage ?? `${fieldName} must be ${description}.`);
    }
    return parsed;
  };
}

export const readRouteFiniteNumber = routeNumberReader(parseStrictFiniteNumber, "a finite number");
export const readRouteInteger = routeNumberReader(parseStrictInteger, "an integer");
export const readRoutePositiveInteger = routeNumberReader(
  parseStrictPositiveInteger,
  "a positive integer",
);
export const readRouteNonNegativeInteger = routeNumberReader(
  parseStrictNonNegativeInteger,
  "a non-negative integer",
);

/** Read an optional finite number, treating blank strings as absent. */
export function readOptionalRouteFiniteNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return readRouteFiniteNumber(value, fieldName);
}

/** Read and normalize an optional positive timeout value. */
export function readRouteTimerTimeoutMs(
  value: unknown,
  fieldName = "timeoutMs",
  opts?: { minMs?: number; invalidMessage?: string },
): number | undefined {
  const parsed = readRoutePositiveInteger(value, fieldName, opts);
  return parsed === undefined ? undefined : normalizeBrowserTimerDelayMs(parsed, opts);
}
