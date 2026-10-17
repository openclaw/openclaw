import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

export function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min: 1 });
}
