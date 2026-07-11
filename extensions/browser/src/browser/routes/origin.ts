/**
 * Shared browser route origin parsing.
 */
import { toStringOrEmpty } from "./utils.js";

/** Return a canonical http(s) origin, or null when the value is absent or invalid. */
export function readHttpOrigin(raw: unknown): string | null {
  const value = toStringOrEmpty(raw);
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}
