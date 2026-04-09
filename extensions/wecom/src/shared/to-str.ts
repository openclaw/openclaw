/**
 * Safely stringify unknown SDK values without triggering typescript/no-base-to-string.
 *
 * WeCom SDK responses contain dynamic fields typed as `unknown`. Using `String(value)`
 * directly triggers the lint rule because `unknown` has no guaranteed `.toString()`.
 * This helper performs a type-safe conversion chain.
 */
export function toStr(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return fallback;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}
