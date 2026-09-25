/**
 * Shared JSON Schema container keyword sets and write helpers for the tool-schema
 * walkers. Schema containers hold nested schemas under different shapes: maps keyed by
 * schema name, a single nested schema, or a list of nested schemas.
 */
export const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

export const SCHEMA_OBJECT_KEYS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
]);

export const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);

export const SCHEMA_LITERAL_KEYS = new Set(["const", "default", "enum", "examples"]);

/** Thrown when a tool schema graph revisits a node on its own walk path. */
export function createCircularToolSchemaError(): TypeError {
  return new TypeError("Tool schema contains a circular reference and cannot be normalized.");
}

/** Assigns without invoking setters so user-named keys such as `__proto__` stay own properties. */
export function setOwnSchemaProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Copies display metadata onto a rebuilt schema record. */
export function copySchemaMeta(from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of ["title", "description", "default"] as const) {
    if (key in from && from[key] !== undefined) {
      to[key] = from[key];
    }
  }
}
