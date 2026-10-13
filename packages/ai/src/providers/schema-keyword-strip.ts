import {
  evaluateSchemaWalk,
  SCHEMA_ARRAY_KEYS,
  SCHEMA_MAP_KEYS,
  SCHEMA_OBJECT_KEYS,
  walkSchemaArray,
  walkSchemaValue,
  type SchemaWalk,
} from "./schema-walk.js";

function* stripSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
  ancestors: Set<object>,
): SchemaWalk {
  const visit = (value: unknown) => stripSchemaKeywords(value, unsupportedKeywords, ancestors);
  return yield walkSchemaValue(schema, ancestors, function* (obj) {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (unsupportedKeywords.has(key)) {
        continue;
      }
      if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        for (const entry of entries) {
          entry[1] = yield visit(entry[1]);
        }
        cleaned[key] = Object.fromEntries(entries);
      } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        cleaned[key] = yield walkSchemaArray(value, visit);
      } else if (SCHEMA_OBJECT_KEYS.has(key) && value && typeof value === "object") {
        cleaned[key] = yield visit(value);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  });
}

/** Remove schema keywords unsupported by a target provider/tool surface. */
export function stripUnsupportedSchemaKeywords(
  schema: unknown,
  unsupportedKeywords: ReadonlySet<string>,
): unknown {
  return evaluateSchemaWalk(stripSchemaKeywords(schema, unsupportedKeywords, new Set()));
}
