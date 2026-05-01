import type { FillSentinel } from "../types.js";

/**
 * Documented well-known sentinel field names. These are guaranteed to be
 * supported by stripe-link and mock adapters. Used for documentation and tests
 * only — runtime validation in `isFillSentinel` accepts any non-empty string
 * `field` value so that fields exposed via `BuyerProfile.extras` (forward-compat
 * passthrough) can flow through without code changes.
 *
 * Resolution against this list (vs. extras vs. unknown) lives in
 * `fill-hook.ts resolveSentinel`.
 */
export const WELL_KNOWN_FIELDS = [
  // Card secrets (Tier 1)
  "pan",
  "cvv",
  "exp_month",
  "exp_year",
  "exp_mm_yy",
  "exp_mm_yyyy",
  // Buyer profile (Tier 2)
  "holder_name",
  "billing_line1",
  "billing_city",
  "billing_state",
  "billing_postal_code",
  "billing_country",
] as const;
export type WellKnownFillField = (typeof WELL_KNOWN_FIELDS)[number];

/**
 * Detects whether a value is a FillSentinel: an object with non-empty
 * string `$paymentHandle` and non-empty string `field`. Defensive: returns
 * false for any malformed shape, including partial sentinels.
 *
 * Note: `field` is intentionally an OPEN string — adapters can expose
 * forward-compat fields via `BuyerProfile.extras` and agents reference them
 * by name. The fill-hook's resolver fails fast with a clear error if the
 * field cannot be resolved against the credential's data; pre-validating
 * against a closed list here would block the forward-compat case.
 */
export function isFillSentinel(value: unknown): value is FillSentinel {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["$paymentHandle"] !== "string" || v["$paymentHandle"].length === 0) return false;
  if (typeof v["field"] !== "string" || v["field"].length === 0) return false;
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
