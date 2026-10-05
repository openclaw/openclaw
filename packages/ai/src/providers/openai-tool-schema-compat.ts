import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TSchema } from "typebox";
import { SCHEMA_ARRAY_KEYS, SCHEMA_MAP_KEYS, SCHEMA_OBJECT_KEYS } from "./schema-walk.js";
import { assertToolSchemaDepth, isWithinToolSchemaDepth } from "./tool-schema-depth.js";

// Annotation-only keywords whose null values can be dropped without changing
// what the schema accepts; null constraint keywords must stay so projection
// quarantines the tool instead of widening it.
const OPENAI_NULLABLE_ANNOTATION_KEYS = new Set([
  "default",
  "description",
  "examples",
  "format",
  "title",
]);

const OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS = new Set(
  [...SCHEMA_OBJECT_KEYS, ...SCHEMA_ARRAY_KEYS].toSorted(),
);

function normalizeOpenAIStrictCompatSchemaMap(schema: unknown, depth = 0): unknown {
  if (!isRecord(schema)) {
    return schema;
  }

  let changed = false;
  // Schema names are literal data; indexed writes would invoke __proto__'s setter.
  const normalized = Object.fromEntries<unknown>(
    Object.entries(schema).map(([key, value]) => {
      // A properties/definitions map is a transparent container: its entries sit
      // one level below the owning schema, matching the shared depth accounting
      // used by the general normalizer (the map itself adds no level).
      const next = normalizeOpenAIStrictCompatSchemaRecursive(value, false, depth);
      changed ||= next !== value;
      return [key, next];
    }),
  );
  return changed ? normalized : schema;
}

function normalizeOpenAIStrictCompatSchemaRecursive(
  schema: unknown,
  promoteEmptyObject = false,
  depth = 0,
): unknown {
  assertToolSchemaDepth(depth);
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      // Array entries historically never promote an empty object, regardless of the root flag.
      const next = normalizeOpenAIStrictCompatSchemaRecursive(entry, false, depth + 1);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  let changed = false;
  let hadNullType = false;
  const entries = Object.entries(record).flatMap(([key, value]): Array<[string, unknown]> => {
    // Repair only null-valued entries that carry no constraint semantics.
    // Null constraints stay invalid so projection quarantines the tool.
    if (value === null && (OPENAI_NULLABLE_ANNOTATION_KEYS.has(key) || key === "type")) {
      hadNullType ||= key === "type";
      changed = true;
      return [];
    }
    const next = SCHEMA_MAP_KEYS.has(key)
      ? normalizeOpenAIStrictCompatSchemaMap(value, depth + 1)
      : OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS.has(key)
        ? normalizeOpenAIStrictCompatSchemaRecursive(value, false, depth + 1)
        : value;
    changed ||= next !== value;
    return [[key, next]];
  });
  const normalized = Object.fromEntries<unknown>(entries);

  if (Object.keys(normalized).length === 0) {
    if (!promoteEmptyObject) {
      return schema;
    }
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }

  const hasObjectShapeHints =
    (normalized.properties &&
      typeof normalized.properties === "object" &&
      !Array.isArray(normalized.properties)) ||
    Array.isArray(normalized.required);
  const hasArrayShapeHints = "items" in normalized;
  if (!("type" in normalized) && hasObjectShapeHints !== hasArrayShapeHints) {
    normalized.type = hasObjectShapeHints ? "object" : "array";
    changed = true;
  } else if (hadNullType && !("type" in normalized)) {
    // Without an unambiguous shape, retain the invalid type so projection
    // rejects the tool instead of widening it to an unconstrained schema.
    normalized.type = null;
  }
  if (normalized.type === "object" && !("properties" in normalized)) {
    normalized.properties = {};
    changed = true;
  }

  const hasEmptyProperties =
    isRecord(normalized.properties) && Object.keys(normalized.properties).length === 0;

  if (normalized.type === "object" && !Array.isArray(normalized.required) && hasEmptyProperties) {
    normalized.required = [];
    changed = true;
  }
  if (
    normalized.type === "object" &&
    hasEmptyProperties &&
    !("additionalProperties" in normalized)
  ) {
    normalized.additionalProperties = false;
    changed = true;
  }

  return changed ? normalized : schema;
}

/** Repairs recoverable OpenAI tool-schema shapes before canonical normalization. */
export function normalizeOpenAIStrictCompatSchema(schema: unknown): TSchema {
  return normalizeOpenAIStrictCompatSchemaRecursive(schema, true) as TSchema;
}

/** Finds schema paths that violate OpenAI strict tool-schema requirements. */
export function findOpenAIStrictSchemaViolations(
  schema: unknown,
  path: string,
  options?: { requireObjectRoot?: boolean },
  depth = 0,
): string[] {
  if (!isWithinToolSchemaDepth(depth)) {
    // Deeper than the shared traversal budget: report and stop instead of
    // overflowing the call stack on externally supplied schemas.
    return [`${path}.depth`];
  }
  if (Array.isArray(schema)) {
    if (options?.requireObjectRoot) {
      return [`${path}.type`];
    }
    return schema.flatMap((item, index) =>
      findOpenAIStrictSchemaViolations(item, `${path}[${index}]`, undefined, depth + 1),
    );
  }
  if (!schema || typeof schema !== "object") {
    return options?.requireObjectRoot ? [`${path}.type`] : [];
  }

  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (key in record) {
      violations.push(`${path}.${key}`);
    }
  }
  if (Array.isArray(record.type)) {
    violations.push(`${path}.type`);
  }

  const properties = isRecord(record.properties) ? record.properties : undefined;

  if (record.type === "object") {
    if (record.additionalProperties !== false) {
      violations.push(`${path}.additionalProperties`);
    }
    const required = Array.isArray(record.required)
      ? record.required.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (!required) {
      violations.push(`${path}.required`);
    } else if (properties) {
      const requiredSet = new Set(required);
      for (const key of Object.keys(properties)) {
        if (!requiredSet.has(key)) {
          violations.push(`${path}.required.${key}`);
        }
      }
    }
  }

  // Schema maps contain user-chosen names. Walk their values as schemas, but
  // never interpret map keys such as `$defs.anyOf` as schema keywords.
  for (const key of SCHEMA_MAP_KEYS) {
    const schemaMap = record[key];
    if (!isRecord(schemaMap)) {
      continue;
    }
    for (const [entryKey, value] of Object.entries(schemaMap)) {
      violations.push(
        ...findOpenAIStrictSchemaViolations(
          value,
          `${path}.${key}.${entryKey}`,
          undefined,
          depth + 1,
        ),
      );
    }
  }
  // Only recurse through JSON Schema applicators. Annotation payloads such as
  // examples/default may contain arbitrary objects that are not schemas.
  for (const key of OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS) {
    const value = record[key];
    if (value && typeof value === "object") {
      violations.push(
        ...findOpenAIStrictSchemaViolations(value, `${path}.${key}`, undefined, depth + 1),
      );
    }
  }

  return violations;
}
