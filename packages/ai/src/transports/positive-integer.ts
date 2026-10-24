import {
  floorPositiveFiniteNumber,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";

export function parsePositiveInteger(value: unknown): number | undefined {
  return typeof value === "string"
    ? parseStrictPositiveInteger(value)
    : floorPositiveFiniteNumber(value);
}
