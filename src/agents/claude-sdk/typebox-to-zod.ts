// Runtime converter from TypeBox schemas (`@sinclair/typebox`) to Zod
// schemas. Needed because OpenClaw's `AgentTool` inventory defines
// parameters with TypeBox, while the Claude Agent SDK registers custom
// tools through the MCP SDK, which accepts Zod schemas only.
//
// Scope: the constructors actually in use across OpenClaw tools (grepped
// during Phase 2xB inventory):
//   Type.Any · Type.Array · Type.Boolean · Type.Integer · Type.Literal
//   Type.Null · Type.Number · Type.Object · Type.Optional · Type.Partial
//   Type.Record · Type.String · Type.Union · Type.Unknown
//
// TypeBox schemas carry two symbol-keyed flags:
//   Symbol.for("TypeBox.Kind")     → constructor name ("String", "Object", …)
//   Symbol.for("TypeBox.Optional") → "Optional" when wrapped in Type.Optional
// The rest of the schema body is plain JSON-Schema-shaped, so the walker
// reads `type` / `properties` / `items` / `anyOf` / `const` directly.
//
// Unsupported shapes return `z.unknown()` with a logged warning rather
// than throwing — OpenClaw's tool-level validation still runs inside
// `AgentTool.execute()`, so the worst case is a looser schema shown to
// the model. Schemas that reference unknown constructors are logged via
// `onUnsupported` so callers can surface them in the run's warning set.

import { z, type ZodTypeAny, type ZodRawShape } from "zod";

const KIND = Symbol.for("TypeBox.Kind");
const OPTIONAL = Symbol.for("TypeBox.Optional");

type AnySchema = Record<string, unknown> & {
  [KIND]?: string;
  [OPTIONAL]?: string;
};

export type TypeBoxConversionOptions = {
  /**
   * Called whenever the walker encounters a schema shape it cannot
   * convert faithfully. The string describes the unsupported kind (e.g.
   * "Type.Never"). Conversion returns `z.unknown()` for that node so
   * the rest of the schema still usable.
   */
  onUnsupported?: (reason: string, schema: unknown) => void;
};

export type TypeBoxConversionResult = {
  /** The converted top-level Zod schema. */
  zod: ZodTypeAny;
  /** Unsupported kind names encountered (deduped, sorted). */
  unsupportedKinds: string[];
};

/**
 * Convert an arbitrary TypeBox schema into a Zod schema. Safe on
 * unknown shapes — emits warnings and falls back to `z.unknown()`.
 */
export function convertTypeBoxSchemaToZod(
  schema: unknown,
  options: TypeBoxConversionOptions = {},
): TypeBoxConversionResult {
  const unsupported = new Set<string>();
  const warn = (reason: string, node: unknown) => {
    unsupported.add(reason);
    options.onUnsupported?.(reason, node);
  };
  const zod = walk(schema, warn);
  return {
    zod,
    unsupportedKinds: [...unsupported].toSorted((a, b) => a.localeCompare(b)),
  };
}

/**
 * Convert a TypeBox `Type.Object(...)` schema into the `ZodRawShape`
 * that the MCP SDK's `tool()` registration expects. Throws if the
 * schema isn't an object kind — tool parameters are always objects in
 * OpenClaw.
 */
export function convertTypeBoxObjectToZodShape(
  schema: unknown,
  options: TypeBoxConversionOptions = {},
): { shape: ZodRawShape; unsupportedKinds: string[] } {
  if (!isPlainObject(schema)) {
    throw new Error("Expected a TypeBox Type.Object schema (plain object).");
  }
  const kind = (schema as AnySchema)[KIND];
  if (kind !== "Object") {
    throw new Error(`Expected a TypeBox Type.Object schema, got kind="${kind ?? "unknown"}".`);
  }

  const unsupported = new Set<string>();
  const warn = (reason: string, node: unknown) => {
    unsupported.add(reason);
    options.onUnsupported?.(reason, node);
  };

  const shape: Record<string, ZodTypeAny> = {};
  const properties = (schema as AnySchema).properties;
  if (isPlainObject(properties)) {
    for (const [key, raw] of Object.entries(properties)) {
      const zodField = walk(raw, warn);
      const isOptional = isPlainObject(raw) && (raw as AnySchema)[OPTIONAL] === "Optional";
      shape[key] = isOptional ? zodField.optional() : zodField;
    }
  }

  return {
    shape: shape as ZodRawShape,
    unsupportedKinds: [...unsupported].toSorted((a, b) => a.localeCompare(b)),
  };
}

// ---------- Internal walker ----------

type WarnFn = (reason: string, node: unknown) => void;

function walk(node: unknown, warn: WarnFn): ZodTypeAny {
  if (!isPlainObject(node)) {
    warn("non-object-schema-node", node);
    return z.unknown();
  }
  const schema = node as AnySchema;
  const kind = schema[KIND];
  switch (kind) {
    case "String":
      return z.string();
    case "Number":
      return z.number();
    case "Integer":
      return z.number().int();
    case "Boolean":
      return z.boolean();
    case "Null":
      return z.null();
    case "Any":
    case "Unknown":
      return z.unknown();
    case "Literal": {
      const value = schema.const;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return z.literal(value);
      }
      warn("Literal-with-non-primitive-value", node);
      return z.unknown();
    }
    case "Array": {
      const items = schema.items;
      return z.array(walk(items, warn));
    }
    case "Union": {
      const anyOf = Array.isArray(schema.anyOf) ? (schema.anyOf as unknown[]) : [];
      const members = anyOf.map((m) => walk(m, warn));
      if (members.length === 0) {
        warn("Union-empty", node);
        return z.unknown();
      }
      if (members.length === 1) {
        // Collapses to the single branch; Zod's z.union requires >= 2.
        return members[0] ?? z.unknown();
      }
      return z.union(members as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    }
    case "Record": {
      // TypeBox emits patternProperties for Record; pick the first
      // value schema and assume string keys (JSON Schema convention).
      const patterns = isPlainObject(schema.patternProperties)
        ? schema.patternProperties
        : undefined;
      const firstValue = patterns ? Object.values(patterns)[0] : undefined;
      const valueSchema = firstValue !== undefined ? walk(firstValue, warn) : z.unknown();
      return z.record(z.string(), valueSchema);
    }
    case "Object": {
      const props = isPlainObject(schema.properties) ? schema.properties : {};
      const out: Record<string, ZodTypeAny> = {};
      for (const [key, raw] of Object.entries(props)) {
        const inner = walk(raw, warn);
        const isOpt = isPlainObject(raw) && (raw as AnySchema)[OPTIONAL] === "Optional";
        out[key] = isOpt ? inner.optional() : inner;
      }
      return z.object(out);
    }
    default: {
      // Fallback by json-schema `type` when no TypeBox Kind symbol is
      // present (e.g., an inline plain JSON-schema fragment).
      const jsonType = schema.type;
      if (jsonType === "string") {
        return z.string();
      }
      if (jsonType === "number") {
        return z.number();
      }
      if (jsonType === "boolean") {
        return z.boolean();
      }
      if (jsonType === "null") {
        return z.null();
      }
      if (jsonType === "array") {
        return z.array(walk(schema.items, warn));
      }
      if (jsonType === "object") {
        const props = isPlainObject(schema.properties) ? schema.properties : {};
        const out: Record<string, ZodTypeAny> = {};
        for (const [key, raw] of Object.entries(props)) {
          out[key] = walk(raw, warn);
        }
        return z.object(out);
      }
      // Only stringify when the value is actually a string-shaped fallback — the
      // no-base-to-string lint rule rejects calling String() on unknown.
      const kindLabel = typeof kind === "string" ? kind : undefined;
      const jsonTypeLabel = typeof jsonType === "string" ? jsonType : undefined;
      warn(`unsupported-kind:${kindLabel ?? jsonTypeLabel ?? "?"}`, node);
      return z.unknown();
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
