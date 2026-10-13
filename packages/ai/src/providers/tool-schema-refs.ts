import { parseLocalSchemaRefPointer } from "@openclaw/normalization-core/json-schema";
import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";
import { SCHEMA_ARRAY_KEYS, SCHEMA_MAP_KEYS, SCHEMA_OBJECT_KEYS } from "./schema-walk.js";
import {
  MAX_TOOL_SCHEMA_DEPTH,
  inheritToolSchemaTruncation,
  reportToolSchemaTruncation,
  truncateToolSchemaDepth,
} from "./tool-schema-depth.js";

export { SCHEMA_ARRAY_KEYS, SCHEMA_MAP_KEYS, SCHEMA_OBJECT_KEYS } from "./schema-walk.js";

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

  const next: SchemaDefs = {
    $defs: new Map(defs?.$defs),
    definitions: new Map(defs?.definitions),
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

function resolveJsonPointerPath(value: unknown, tokens: readonly string[]): unknown {
  let current = value;
  for (const key of tokens) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
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

export const SCHEMA_LITERAL_KEYS = new Set(["const", "default", "enum", "examples"]);

function tryResolveLocalRef(
  ref: string,
  defs: SchemaDefs | undefined,
  rootDocument: unknown,
): unknown {
  const tokens = parseLocalSchemaRefPointer(ref);
  if (!tokens) {
    return undefined;
  }
  const [table, name, ...remainingPath] = tokens;
  if (defs && name && (table === "$defs" || table === "definitions")) {
    const resolved = (table === "$defs" ? defs.$defs : defs.definitions).get(name);
    if (resolved !== undefined) {
      return resolveJsonPointerPath(resolved, remainingPath);
    }
  }
  return resolveJsonPointerPath(rootDocument, tokens);
}

function inlineLocalSchemaRefsWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
  state: { unresolvedLocalRefs: boolean; truncated: boolean },
  rootDocument: unknown,
  depth = 0,
): unknown {
  if (depth > MAX_TOOL_SCHEMA_DEPTH) {
    state.truncated = true;
    return {};
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) =>
      inlineLocalSchemaRefsWithDefs(entry, defs, refStack, state, rootDocument, depth + 1),
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
      // Keep definition tables for any local pointer left in place, encoded or not.
      if (refValue.startsWith("#/") || parseLocalSchemaRefPointer(refValue)) {
        state.unresolvedLocalRefs = true;
      }
      return { ...obj };
    }
    const nextRefStack = new Set(refStack);
    nextRefStack.add(refValue);
    const inlined = inlineLocalSchemaRefsWithDefs(
      resolved,
      nextDefs,
      nextRefStack,
      state,
      rootDocument,
      depth + 1,
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
    let next = value;
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      const entries = Object.entries(value);
      for (const entry of entries) {
        if (key === "dependencies" && Array.isArray(entry[1])) {
          continue;
        }
        entry[1] = inlineLocalSchemaRefsWithDefs(
          entry[1],
          nextDefs,
          refStack,
          state,
          rootDocument,
          depth + 1,
        );
      }
      next = Object.fromEntries(entries);
    } else if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
      next = inlineLocalSchemaRefsWithDefs(
        value,
        nextDefs,
        refStack,
        state,
        rootDocument,
        depth + 1,
      );
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      next = value.map((entry) =>
        inlineLocalSchemaRefsWithDefs(entry, nextDefs, refStack, state, rootDocument, depth + 1),
      );
    }
    setOwnSchemaProperty(result, key, next);
  }
  if (state.unresolvedLocalRefs) {
    for (const key of ["$defs", "definitions", "components"]) {
      if (key in obj) {
        result[key] = obj[key];
      }
    }
  }
  return result;
}

/** Inline local $ref pointers so providers receive self-contained tool schemas. */
export function inlineLocalToolSchemaRefs(schema: unknown, toolName?: string): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const boundedSchema = truncateToolSchemaDepth(schema, toolName);
  const state = { unresolvedLocalRefs: false, truncated: false };
  // SAFETY: Objects, including legacy array roots, can carry definition-table keys.
  const schemaRecord = boundedSchema as Record<string, unknown>;
  const normalized = inlineLocalSchemaRefsWithDefs(
    boundedSchema,
    Array.isArray(boundedSchema) ? extendSchemaDefs(undefined, schemaRecord) : undefined,
    undefined,
    state,
    boundedSchema,
  );
  const bounded = truncateToolSchemaDepth(normalized);
  if (state.truncated || bounded !== normalized) {
    reportToolSchemaTruncation(schema, toolName);
  }
  return inheritToolSchemaTruncation(boundedSchema, bounded, state.truncated);
}

/** Keep compact root definitions. Fall back for scopes or refs we must rewrite. */
export function canPreserveRootSchemaRefs(inputSchema: unknown): boolean {
  const schema = truncateToolSchemaDepth(inputSchema);
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
        tryResolveLocalRef(node.$ref, undefined, schema) === undefined
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
