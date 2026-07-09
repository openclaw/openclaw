// Small string normalization helpers kept local to memory-host-sdk for package
// builds that should not depend on the full normalization package graph.
/** Normalize a non-empty string or return null. */
function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Normalize a non-empty string or return undefined. */
export function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeNullableString(value) ?? undefined;
}

/** Normalize a non-empty string to lowercase or return undefined. */
export function normalizeOptionalLowercaseString(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

/** Truncate without cutting a UTF-16 surrogate pair in half. */
export function truncateUtf16Safe(value: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (value.length <= limit) {
    return value;
  }
  if (
    limit > 0 &&
    limit < value.length &&
    value.charCodeAt(limit - 1) >= 0xd800 &&
    value.charCodeAt(limit - 1) <= 0xdbff &&
    value.charCodeAt(limit) >= 0xdc00 &&
    value.charCodeAt(limit) <= 0xdfff
  ) {
    return value.slice(0, limit - 1);
  }
  return value.slice(0, limit);
}

/** Normalize a value to lowercase text, defaulting to an empty string. */
export function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

/** Normalize an array-like list of values into non-empty strings. */
export function normalizeStringEntries(values: ReadonlyArray<unknown>): string[] {
  return values.map((value) => normalizeOptionalString(String(value)) ?? "").filter(Boolean);
}

/** Return unique strings preserving first-seen order. */
export function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)];
}
