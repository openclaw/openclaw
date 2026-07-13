// Voice Call plugin module implements deep merge behavior.
// @ts-expect-error defu 6.1.5's export= declaration hides its shipped ESM named exports.
import { createDefu } from "defu";
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";

// Prototype-safe deep merge for config overrides that ignores undefined values.

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NULL_OVERRIDE = Symbol("null-override");

function prepareObject(
  value: Record<string, unknown>,
  encodeNull: boolean,
): Record<string, unknown> {
  const prepared: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (BLOCKED_MERGE_KEYS.has(key)) {
      continue;
    }
    if (encodeNull && entry === null) {
      prepared[key] = NULL_OVERRIDE;
    } else if (isPlainObject(entry)) {
      prepared[key] = prepareObject(entry, encodeNull);
    } else {
      prepared[key] = entry;
    }
  }
  return prepared;
}

function decodeNullOverrides(value: unknown): unknown {
  if (value === NULL_OVERRIDE) {
    return null;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeNullOverrides(entry)]),
  );
}

const mergeObjects = createDefu(
  (object: Record<PropertyKey, unknown>, key: PropertyKey, value: unknown) => {
    if (typeof key === "string" && BLOCKED_MERGE_KEYS.has(key)) {
      return true;
    }
    if (value === NULL_OVERRIDE) {
      object[key] = null;
      return true;
    }
    if (Array.isArray(value)) {
      object[key] = value;
      return true;
    }
    return false;
  },
);

/** Deep-merge plain objects, keeping base values when overrides are undefined. */
export function deepMergeDefined(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  return decodeNullOverrides(
    mergeObjects(prepareObject(override, true), prepareObject(base, false)),
  );
}
