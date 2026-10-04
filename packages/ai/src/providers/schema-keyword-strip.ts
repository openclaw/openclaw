import {
  evaluateSchemaWalk,
  SCHEMA_ARRAY_KEYS,
  SCHEMA_MAP_KEYS,
  SCHEMA_OBJECT_KEYS,
  type SchemaWalk,
} from "./schema-walk.js";

function* stripSchemaArray(
  schemas: unknown[],
  unsupportedKeywords: ReadonlySet<string>,
  ancestors: Set<object>,
): SchemaWalk {
  const result: unknown[] = [];
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
      return yield stripSchemaArray(schema, unsupportedKeywords, ancestors);
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
        cleaned[key] = yield stripSchemaArray(value, unsupportedKeywords, ancestors);
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
