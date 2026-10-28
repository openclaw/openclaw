import {
  SCHEMA_ARRAY_KEYS,
  SCHEMA_MAP_KEYS,
  SCHEMA_OBJECT_KEYS,
  walkSchemaValue,
} from "./schema-walk.js";
import { inheritToolSchemaTruncation, truncateToolSchemaDepth } from "./tool-schema-depth.js";

function stripSchemaKeywords(schema: unknown, unsupportedKeywords: ReadonlySet<string>): unknown {
  const visit = (value: unknown) => stripSchemaKeywords(value, unsupportedKeywords);
  return walkSchemaValue(schema, (obj) => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (unsupportedKeywords.has(key)) {
        continue;
      }
      if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        for (const entry of entries) {
          // Property dependencies contain names, not schemas; the depth owner leaves them intact.
          if (key !== "dependencies" || !Array.isArray(entry[1])) {
            entry[1] = visit(entry[1]);
          }
        }
        cleaned[key] = Object.fromEntries(entries);
      } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        cleaned[key] = value.map(visit);
      } else if (SCHEMA_OBJECT_KEYS.has(key) && value && typeof value === "object") {
        cleaned[key] = visit(value);
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
  const bounded = truncateToolSchemaDepth(schema);
  return inheritToolSchemaTruncation(bounded, stripSchemaKeywords(bounded, unsupportedKeywords));
}
