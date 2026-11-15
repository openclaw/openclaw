import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAiTransportHost } from "../host.js";
import { SCHEMA_ARRAY_KEYS, SCHEMA_MAP_KEYS, SCHEMA_OBJECT_KEYS } from "./schema-walk.js";

/** Schema nodes and expanded references share this budget; containers are transparent. */
// Leave stack headroom for TypeBox's generated validators and native grammar compilers.
export const MAX_TOOL_SCHEMA_DEPTH = 128;

export type ToolSchemaPosition = {
  kind: "schema" | "map" | "array" | "dependencies";
  depth: number;
};

/** Classify children after toJSON when serializing, or directly when normalizing. */
export function toolSchemaChildPosition(
  position: ToolSchemaPosition | undefined,
  parent: object,
  key: string,
  child: unknown,
): ToolSchemaPosition | undefined {
  if (!position || (typeof child !== "boolean" && (!child || typeof child !== "object"))) {
    return undefined;
  }
  if (position.kind === "dependencies" && Array.isArray(child)) {
    return undefined;
  }
  if (position.kind !== "schema" || Array.isArray(parent)) {
    return { kind: "schema", depth: position.depth + 1 };
  }
  if (SCHEMA_MAP_KEYS.has(key) && isRecord(child)) {
    return {
      kind: key === "dependencies" ? "dependencies" : "map",
      depth: position.depth,
    };
  }
  if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
    return { kind: "array", depth: position.depth };
  }
  return SCHEMA_OBJECT_KEYS.has(key) ? { kind: "schema", depth: position.depth + 1 } : undefined;
}

const reportedSchemas = new WeakMap<object, Set<string>>();
const truncatedSchemaResults = new WeakSet<object>();

export function wasToolSchemaTruncated(schema: unknown): boolean {
  return schema !== null && typeof schema === "object" && truncatedSchemaResults.has(schema);
}

/** Preserve reduced-validation provenance across schema copies without repeating diagnostics. */
export function inheritToolSchemaTruncation<T>(source: unknown, result: T, truncated = false): T {
  if (result && typeof result === "object") {
    if (truncated || wasToolSchemaTruncated(source)) {
      truncatedSchemaResults.add(result);
    }
    const names = source && typeof source === "object" ? reportedSchemas.get(source) : undefined;
    if (names) {
      reportedSchemas.set(result, names);
    }
  }
  return result;
}

export function reportToolSchemaTruncation(schema: unknown, toolName?: string): void {
  if (!schema || typeof schema !== "object") {
    return;
  }
  const names = reportedSchemas.get(schema) ?? new Set<string>();
  reportedSchemas.set(schema, names);
  if (!toolName || names.has(toolName)) {
    return;
  }
  names.add(toolName);
  getAiTransportHost().logWarn(
    "[tool-schema]",
    `Tool "${toolName}" schema exceeds ${MAX_TOOL_SCHEMA_DEPTH} nested levels; deep subschemas were replaced with {}. The tool remains available with reduced validation.`,
  );
}

/** Bound schema structure without changing literal data or caching mutable provider inputs. */
export function truncateToolSchemaDepth(schema: unknown, toolName?: string): unknown {
  const ancestors = new Set<object>();
  let truncated = false;
  function visit(node: unknown, position: ToolSchemaPosition | undefined): unknown {
    if (!position) {
      return node;
    }
    if (position.kind === "schema" && wasToolSchemaTruncated(node)) {
      truncated = true;
    }
    if (position.kind === "schema" && position.depth > MAX_TOOL_SCHEMA_DEPTH) {
      truncated = true;
      return {};
    }
    if (!node || typeof node !== "object") {
      return node;
    }
    if (ancestors.has(node)) {
      throw new TypeError("Tool schema contains a circular reference.");
    }
    ancestors.add(node);
    try {
      if (Array.isArray(node)) {
        let changed = false;
        const entries = node.map((entry, index) => {
          const next = visit(entry, toolSchemaChildPosition(position, node, String(index), entry));
          changed ||= next !== entry;
          return next;
        });
        return changed ? entries : node;
      }
      let changed = false;
      const entries = Object.entries(node).map(([key, value]) => {
        const next = visit(value, toolSchemaChildPosition(position, node, key, value));
        changed ||= next !== value;
        return [key, next];
      });
      return changed ? Object.fromEntries(entries) : node;
    } finally {
      ancestors.delete(node);
    }
  }
  const normalized = visit(schema, { kind: "schema", depth: 0 });
  if (truncated) {
    reportToolSchemaTruncation(schema, toolName);
  }
  return inheritToolSchemaTruncation(schema, normalized, truncated);
}
