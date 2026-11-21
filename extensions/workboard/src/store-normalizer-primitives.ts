import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeBoundedString(
  value: unknown,
  fallback: string | undefined,
  maxLength: number,
  fieldName: string,
): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > maxLength) {
    throw new Error(
      `${fieldName} must be ${maxLength} characters or fewer (got ${normalized.length}).`,
    );
  }
  return normalized;
}

export function normalizeEnumValue<T extends string, TFallback extends T | undefined>(
  value: unknown,
  allowed: readonly T[],
  fallback: TFallback,
  fieldName?: string,
): T | TFallback {
  const match = allowed.find((option) => option === value);
  if (match !== undefined) {
    return match;
  }
  if (fieldName && typeof value === "string" && value.trim()) {
    throw new Error(`${fieldName} must be one of: ${allowed.join(", ")}.`);
  }
  return fallback;
}

export function normalizeTimestamp(value: unknown, fallback: number): number {
  return resolveOptionalIntegerOption(value, { min: 0 }) ?? fallback;
}
