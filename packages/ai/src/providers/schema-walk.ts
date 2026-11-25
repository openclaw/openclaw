import { asRecord } from "@openclaw/normalization-core/record-coerce";

// Schema-bearing containers shared by the draft-07 through 2020-12 walkers.
export const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  // Draft-07 dependencies mix schemas with property-name arrays. Stripping
  // leaves the string entries in those arrays unchanged.
  "dependencies",
  "patternProperties",
  "properties",
]);

/** Containers whose value is a single nested schema. */
export const SCHEMA_OBJECT_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

/** Containers whose value is a list of nested schemas. */
export const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);
export const SCHEMA_NESTED_KEYS = new Set([...SCHEMA_OBJECT_KEYS, ...SCHEMA_ARRAY_KEYS].toSorted());

/** Callers bound schema depth before walking; ordinary recursion stays within that budget. */
export function walkSchemaValue(
  schema: unknown,
  visitObject: (schema: Record<string, unknown>) => unknown,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  return Array.isArray(schema)
    ? schema.map((entry) => walkSchemaValue(entry, visitObject))
    : visitObject(asRecord(schema));
}
