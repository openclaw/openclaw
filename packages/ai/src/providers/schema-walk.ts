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

export type SchemaWalk = Generator<SchemaWalk, unknown, unknown>;

export function* walkSchemaArray(
  schemas: unknown[],
  visit: (schema: unknown) => SchemaWalk,
  result: unknown[] = [],
): SchemaWalk {
  result.length = schemas.length;
  for (let index = 0; index < result.length; index += 1) {
    if (index in schemas) {
      result[index] = yield visit(schemas[index]);
    }
  }
  return result;
}

export function* walkSchemaValue(
  schema: unknown,
  ancestors: Set<object>,
  visitObject: (schema: Record<string, unknown>) => SchemaWalk,
): SchemaWalk {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (ancestors.has(schema)) {
    throw new TypeError("Tool schema contains a circular reference.");
  }
  ancestors.add(schema);
  try {
    return yield Array.isArray(schema)
      ? walkSchemaArray(schema, (entry) => walkSchemaValue(entry, ancestors, visitObject))
      : visitObject(asRecord(schema));
  } finally {
    ancestors.delete(schema);
  }
}

/** Resume child schema walks on a heap stack, never through recursive yield delegation. */
export function evaluateSchemaWalk(walk: SchemaWalk): unknown {
  const parents: SchemaWalk[] = [];
  let current = walk;
  let value: unknown;
  try {
    while (true) {
      const step = current.next(value);
      if (!step.done) {
        parents.push(current);
        current = step.value;
        value = undefined;
        continue;
      }
      value = step.value;
      const parent = parents.pop();
      if (!parent) {
        return value;
      }
      current = parent;
    }
  } finally {
    // Unwind path-local cycle tracking if a child rejects the schema.
    let parent: SchemaWalk | undefined;
    while ((parent = parents.pop())) {
      parent.return(undefined);
    }
  }
}
