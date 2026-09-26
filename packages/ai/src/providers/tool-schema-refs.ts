import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";

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

type SchemaDefs = {
  $defs: Map<string, unknown>;
  definitions: Map<string, unknown>;
};

export function copySchemaMeta(from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of ["title", "description", "default"] as const) {
    if (key in from && from[key] !== undefined) {
      to[key] = from[key];
    }
  }
}

function extendSchemaDefs(
  defs: SchemaDefs | undefined,
  schema: Record<string, unknown>,
): SchemaDefs | undefined {
  const defsEntry = isSchemaRecord(schema.$defs) ? schema.$defs : undefined;
  const legacyDefsEntry = isSchemaRecord(schema.definitions) ? schema.definitions : undefined;

  if (!defsEntry && !legacyDefsEntry) {
    return defs;
  }

  const next: SchemaDefs = defs
    ? {
        $defs: new Map(defs.$defs),
        definitions: new Map(defs.definitions),
      }
    : {
        $defs: new Map<string, unknown>(),
        definitions: new Map<string, unknown>(),
      };
  if (defsEntry) {
    for (const [key, value] of Object.entries(defsEntry)) {
      next.$defs.set(key, value);
    }
  }
  if (legacyDefsEntry) {
    for (const [key, value] of Object.entries(legacyDefsEntry)) {
      next.definitions.set(key, value);
    }
  }
  return next;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointerPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    const key = decodeJsonPointerSegment(segment);
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
      if (index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isSchemaRecord(current) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function resolveLocalJsonPointer(rootDocument: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  return resolveJsonPointerPath(rootDocument, ref.slice(2).split("/"));
}

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

function tryResolveLocalRef(
  ref: string,
  defs: SchemaDefs | undefined,
  rootDocument: unknown,
): unknown {
  const match = ref.match(/^#\/(\$defs|definitions)\/([^/]+)(?:\/(.*))?$/);
  if (match && defs) {
    const namespace = match[1] === "$defs" ? defs.$defs : defs.definitions;
    const name = decodeJsonPointerSegment(match[2] ?? "");
    const resolved = name ? namespace.get(name) : undefined;
    if (resolved !== undefined) {
      const remainingPath = match[3] ? match[3].split("/") : [];
      return resolveJsonPointerPath(resolved, remainingPath);
    }
  }
  return resolveLocalJsonPointer(rootDocument, ref);
}

function inlineLocalSchemaRefsWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
  state: { unresolvedLocalRefs: boolean },
  rootDocument: unknown,
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) =>
      inlineLocalSchemaRefsWithDefs(entry, defs, refStack, state, rootDocument),
    );
  }

  if (!isSchemaRecord(schema)) {
    return schema;
  }
  const obj = schema;
  const nextDefs = extendSchemaDefs(defs, obj);
  const refValue = typeof obj.$ref === "string" ? obj.$ref : undefined;

  if (refValue) {
    if (refStack?.has(refValue)) {
      return {};
    }
    const resolved = tryResolveLocalRef(refValue, nextDefs, rootDocument);
    if (resolved === undefined) {
      if (refValue.startsWith("#/")) {
        state.unresolvedLocalRefs = true;
      }
      return { ...obj };
    }
    const nextRefStack = refStack ? new Set(refStack) : new Set<string>();
    nextRefStack.add(refValue);
    const inlined = inlineLocalSchemaRefsWithDefs(
      resolved,
      nextDefs,
      nextRefStack,
      state,
      rootDocument,
    );
    if (!isSchemaRecord(inlined)) {
      return inlined;
    }
    const result: Record<string, unknown> = { ...inlined };
    copySchemaMeta(obj, result);
    if (obj.nullable === true) {
      result.nullable = true;
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$defs" || key === "definitions" || key === "components") {
      continue;
    }
    if (SCHEMA_LITERAL_KEYS.has(key)) {
      setOwnSchemaProperty(result, key, value);
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      const entries = Object.entries(value);
      for (const entry of entries) {
        entry[1] = inlineLocalSchemaRefsWithDefs(entry[1], nextDefs, refStack, state, rootDocument);
      }
      setOwnSchemaProperty(result, key, Object.fromEntries(entries));
      continue;
    }
    if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
      setOwnSchemaProperty(
        result,
        key,
        inlineLocalSchemaRefsWithDefs(value, nextDefs, refStack, state, rootDocument),
      );
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      setOwnSchemaProperty(
        result,
        key,
        value.map((entry) =>
          inlineLocalSchemaRefsWithDefs(entry, nextDefs, refStack, state, rootDocument),
        ),
      );
      continue;
    }
    setOwnSchemaProperty(result, key, value);
  }
  if (state.unresolvedLocalRefs) {
    if ("$defs" in obj) {
      result.$defs = obj.$defs;
    }
    if ("definitions" in obj) {
      result.definitions = obj.definitions;
    }
    if ("components" in obj) {
      result.components = obj.components;
    }
  }
  return result;
}

/** Inline local $ref pointers so providers receive self-contained tool schemas. */
export function inlineLocalToolSchemaRefs(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  // SAFETY: Objects, including legacy array roots, can carry definition-table keys.
  const schemaRecord = schema as Record<string, unknown>;
  return inlineLocalSchemaRefsWithDefs(
    schema,
    Array.isArray(schema) ? extendSchemaDefs(undefined, schemaRecord) : undefined,
    undefined,
    {
      unresolvedLocalRefs: false,
    },
    schema,
  );
}

/** Keep compact root definitions. Fall back for scopes or refs we must rewrite. */
export function canPreserveRootSchemaRefs(schema: unknown): boolean {
  if (
    !isSchemaRecord(schema) ||
    schema.type !== "object" ||
    !isSchemaRecord(schema.properties) ||
    ["$defs", "definitions"].some((key) => key in schema && !isSchemaRecord(schema[key])) ||
    ["anyOf", "oneOf", "allOf"].some((key) => Array.isArray(schema[key])) ||
    "$ref" in schema
  ) {
    return false;
  }
  let hasRefs = false;
  const ancestors = new Set<object>();
  function visit(node: unknown, inDefinitions = false): boolean {
    if (!isSchemaRecord(node)) {
      return true;
    }
    if (
      ancestors.has(node) ||
      "$id" in node ||
      "id" in node ||
      "components" in node ||
      (node !== schema && ("$defs" in node || "definitions" in node))
    ) {
      return false;
    }
    if ("$ref" in node) {
      if (
        typeof node.$ref !== "string" ||
        !/^#\/(\$defs|definitions)\/[^/]+$/.test(node.$ref) ||
        node.nullable === true ||
        resolveLocalJsonPointer(schema, node.$ref) === undefined
      ) {
        return false;
      }
      // Unused definitions must not keep an otherwise reference-free schema large.
      hasRefs ||= !inDefinitions;
    }
    ancestors.add(node);
    try {
      for (const [key, value] of Object.entries(node)) {
        if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
          const childInDefinitions = inDefinitions || key === "$defs" || key === "definitions";
          if (!Object.values(value).every((entry) => visit(entry, childInDefinitions))) {
            return false;
          }
        } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
          if (!value.every((entry) => visit(entry, inDefinitions))) {
            return false;
          }
        } else if (SCHEMA_OBJECT_KEYS.has(key) && !visit(value, inDefinitions)) {
          return false;
        }
      }
      return true;
    } finally {
      ancestors.delete(node);
    }
  }
  return visit(schema) && hasRefs;
}
