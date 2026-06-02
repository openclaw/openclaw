import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Deep-merges plain config objects while treating undefined overrides as "leave base intact". */
export function deepMergeDefined(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // Config merges can consume user-authored objects, so skip prototype keys before recursion.
    if (BLOCKED_MERGE_KEYS.has(key) || value === undefined) {
      continue;
    }

    const existing = result[key];
    result[key] = key in result ? deepMergeDefined(existing, value) : value;
  }

  return result;
}
