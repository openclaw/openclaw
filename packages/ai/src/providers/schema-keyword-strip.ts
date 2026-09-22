import { evaluateSchemaWalk, type SchemaWalk } from "./schema-walk.js";

// This helper accepts draft-07 through 2020-12 schemas. Keep the union of
// schema-bearing keys aligned with the package's dialect-specific walkers.
const SCHEMA_MAP_KEYS = new Set([
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
const SCHEMA_OBJECT_KEYS = new Set([
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
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "items", "oneOf", "prefixItems"]);

function* stripSchemaArray(
  schemas: unknown[],
  unsupportedKeywords: ReadonlySet<string>,
  ancestors: Set<object>,
  result: unknown[],
): SchemaWalk {
  result.length = schemas.length;
  for (let index = 0; index < result.length; index += 1) {
    if (index in schemas) {
      result[index] = yield stripSchemaKeywords(schemas[index], unsupportedKeywords, ancestors);
    }
  }
  return result;
}

function* stripSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
  ancestors: Set<object>,
): SchemaWalk {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (ancestors.has(schema)) {
    throw new TypeError("Tool schema contains a circular reference.");
  }
  ancestors.add(schema);
  try {
    if (Array.isArray(schema)) {
      const result: unknown[] = [];
      yield stripSchemaArray(schema, unsupportedKeywords, ancestors, result);
      return result;
    }
    const obj = schema as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (unsupportedKeywords.has(key)) {
        continue;
      }
      if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        for (const entry of entries) {
          entry[1] = yield stripSchemaKeywords(entry[1], unsupportedKeywords, ancestors);
        }
        cleaned[key] = Object.fromEntries(entries);
      } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        const result: unknown[] = [];
        yield stripSchemaArray(value, unsupportedKeywords, ancestors, result);
        cleaned[key] = result;
      } else if (SCHEMA_OBJECT_KEYS.has(key) && value && typeof value === "object") {
        cleaned[key] = yield stripSchemaKeywords(value, unsupportedKeywords, ancestors);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  } finally {
    ancestors.delete(schema);
  }
}

/** Remove schema keywords unsupported by a target provider/tool surface. */
export function stripUnsupportedSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
): unknown {
  return evaluateSchemaWalk(stripSchemaKeywords(schema, unsupportedKeywords, new Set()));
}
