import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

export const WRITE_DIFF_MAX_BYTES = 1024 * 1024;

/** Normalizes optional positive numeric limits to a finite integer. */
export function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min: 1 });
}
