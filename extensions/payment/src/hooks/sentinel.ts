import type { FillSentinel } from "../types.js";

export const FILL_SENTINEL_FIELDS = [
  "pan",
  "cvv",
  "exp_month",
  "exp_year",
  "exp_mm_yy",
  "exp_mm_yyyy",
  "holder_name",
] as const;
export type FillSentinelField = (typeof FILL_SENTINEL_FIELDS)[number];

/**
 * Detects whether a value is a FillSentinel: an object with `$paymentHandle: string`
 * and `field` matching one of the known FILL_SENTINEL_FIELDS values. Defensive: returns
 * false for any malformed shape, including partial sentinels.
 */
export function isFillSentinel(value: unknown): value is FillSentinel {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["$paymentHandle"] !== "string" || v["$paymentHandle"].length === 0) return false;
  if (typeof v["field"] !== "string") return false;
  if (!FILL_SENTINEL_FIELDS.includes(v["field"] as FillSentinelField)) return false;
  return true;
}

/**
 * Extracts all FillSentinels from a list of BrowserFormField-like objects.
 * Returns array of (index, sentinel) pairs so the caller can mutate the
 * corresponding entries.
 */
export function findSentinelsInFields(
  fields: ReadonlyArray<{ value?: unknown }>,
): Array<{ index: number; sentinel: FillSentinel }> {
  const out: Array<{ index: number; sentinel: FillSentinel }> = [];
  fields.forEach((f, index) => {
    if (isFillSentinel(f.value)) {
      out.push({ index, sentinel: f.value });
    }
  });
  return out;
}
