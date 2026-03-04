/**
 * Schema Adapter: TypeBox → Zod
 *
 * Converts TypeBox (JSON Schema) parameter schemas to Zod raw shapes for use
 * with the Agent SDK's tool() helper. Handles the subset of TypeBox types used
 * by OpenClaw tools.
 *
 * Supported conversions:
 *   Type.String    → z.string()
 *   Type.Number    → z.number()
 *   Type.Boolean   → z.boolean()
 *   Type.Array(T)  → z.array(zodT)
 *   Type.Object    → z.object({...})
 *   Type.Object (additionalProperties: true) → z.looseObject({...})
 *   Type.Optional  → zodT.optional()
 *   Type.Union     → z.union([...])
 *   Type.Enum      → z.enum([...])
 *   Type.Literal   → z.literal(V)
 *   Type.Unsafe (with enum) → z.enum([...])  [used by stringEnum()]
 *
 * Why hand-rolled instead of @sinclair/typemap?
 *
 * `@sinclair/typemap` is the canonical TypeBox → Zod adapter, but as of
 * February 2026 it declares a peer dependency of `zod: "^3.24.1"` while
 * OpenClaw uses Zod v4. Two additional gaps block a clean swap:
 *
 *   1. Zod v4 API drift — typemap generates v3-style calls (e.g. `.passthrough()`
 *      instead of `z.looseObject()`), so `additionalProperties: true` objects
 *      would not produce the correct Zod v4 output.
 *
 *   2. Type.Unsafe / stringEnum — OpenClaw uses `Type.Unsafe({type:"string", enum:[...]})
 *      to emit a flat JSON Schema enum and avoid `anyOf` (which some providers reject).
 *      typemap treats Unsafe as z.unknown(); we need z.enum() here.
 *
 * When @sinclair/typemap ships Zod v4 support, revisit: the existing tests
 * already serve as the behavioral contract for a drop-in swap.
 */

import { Kind, OptionalKind, type TSchema } from "@sinclair/typebox";
import { z } from "zod";

type ZodTypeAny = z.ZodTypeAny;
type ZodRawShape = z.ZodRawShape;

/**
 * Converts a single TypeBox property schema to a Zod type.
 * Preserves description annotations.
 *
 * TypeBox Optional adds Symbol(TypeBox.Optional) = "Optional" to the schema WITHOUT
 * changing the Kind. We detect it via OptionalKind and wrap the base conversion
 * in .optional() to avoid infinite recursion.
 */
export function typeboxPropertyToZod(schema: TSchema): ZodTypeAny {
  const kind = schema[Kind] as string | undefined;

  // TypeBox Optional adds Symbol(TypeBox.Optional) = "Optional" to the schema.
  // It does NOT change the Kind — so we must check for the symbol explicitly.
  const isOptional = (schema as unknown as Record<symbol, unknown>)[OptionalKind] === "Optional";
  if (isOptional) {
    // Convert the base type by kind (skipping Optional detection to avoid recursion)
    const base = typeboxKindToZod(kind, schema);
    return applyDescription(base.optional(), schema.description);
  }

  return typeboxKindToZod(kind, schema);
}

/**
 * Converts a TypeBox schema based on its Kind. Does NOT handle Optional —
 * that is done in typeboxPropertyToZod before calling here.
 */
function typeboxKindToZod(kind: string | undefined, schema: TSchema): ZodTypeAny {
  // Literal
  if (kind === "Literal") {
    const val = (schema as { const?: unknown }).const;
    return applyDescription(z.literal(val as string | number | boolean), schema.description);
  }

  // Unsafe — Type.Unsafe() is used by stringEnum() to emit a flat JSON Schema enum
  // (avoids anyOf which some providers reject). Detect the enum array and reconstruct
  // a proper z.enum() rather than falling through to z.unknown().
  if (kind === "Unsafe") {
    const enumValues = (schema as { enum?: unknown[] }).enum;
    if (Array.isArray(enumValues) && enumValues.length >= 1) {
      return applyDescription(enumValuesToZod(enumValues), schema.description);
    }
    // Other Unsafe shapes (no enum) — fall through to z.unknown()
    return applyDescription(z.unknown(), schema.description);
  }

  // Enum — TypeBox enum schemas have a list of literal values
  if (kind === "Enum") {
    const values = (schema as { enum?: unknown[] }).enum;
    if (values && values.length >= 1) {
      return applyDescription(enumValuesToZod(values), schema.description);
    }
    return applyDescription(z.unknown(), schema.description);
  }

  // Union
  if (kind === "Union") {
    const anyOf = (schema as { anyOf?: TSchema[] }).anyOf ?? [];
    if (anyOf.length < 2) {
      return applyDescription(z.unknown(), schema.description);
    }
    const [first, second, ...rest] = anyOf.map(typeboxPropertyToZod);
    return applyDescription(
      z.union([first, second, ...rest] as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]),
      schema.description,
    );
  }

  // String
  if (kind === "String") {
    return applyDescription(z.string(), schema.description);
  }

  // Number / Integer
  if (kind === "Number" || kind === "Integer") {
    return applyDescription(z.number(), schema.description);
  }

  // Boolean
  if (kind === "Boolean") {
    return applyDescription(z.boolean(), schema.description);
  }

  // Array
  if (kind === "Array") {
    const items = (schema as { items?: TSchema }).items;
    const itemZod = items ? typeboxPropertyToZod(items) : z.unknown();
    return applyDescription(z.array(itemZod), schema.description);
  }

  // Nested Object
  if (kind === "Object") {
    const shape = typeboxToZod(schema);
    const additionalProperties = (schema as { additionalProperties?: unknown })
      .additionalProperties;
    // z.looseObject() is the Zod v4 API for passthrough (allows extra properties through).
    const zodObj = additionalProperties === true ? z.looseObject(shape) : z.object(shape);
    return applyDescription(zodObj, schema.description);
  }

  // Null
  if (kind === "Null") {
    return applyDescription(z.null(), schema.description);
  }

  // Unknown / fallback
  return applyDescription(z.unknown(), schema.description);
}

/**
 * Converts a TypeBox TObject schema to a Zod raw shape (for use with tool()).
 * For non-object schemas, returns a fallback shape with an optional _input field.
 */
export function typeboxToZod(schema: TSchema): ZodRawShape {
  if (
    schema[Kind] === "Object" &&
    (schema as { properties?: Record<string, TSchema> }).properties
  ) {
    const schemaAsObj = schema as unknown as {
      properties: Record<string, TSchema>;
      required?: string[];
    };
    const props = schemaAsObj.properties;
    const required = new Set<string>(schemaAsObj.required ?? []);
    const shape: Record<string, ZodTypeAny> = {};

    for (const [key, propSchema] of Object.entries(props)) {
      let zodType = typeboxPropertyToZod(propSchema);

      // If the field is not required and not already Optional-marked, make it optional.
      const propIsOptional =
        (propSchema as unknown as Record<symbol, unknown>)[OptionalKind] === "Optional";
      if (!required.has(key) && !propIsOptional) {
        const isAlreadyOptional = zodType instanceof z.ZodOptional;
        if (!isAlreadyOptional) {
          zodType = zodType.optional();
        }
      }

      // Carry over description annotation from property schema
      if (propSchema.description && !zodType.description) {
        zodType = zodType.describe(propSchema.description);
      }

      shape[key] = zodType;
    }
    return shape as ZodRawShape;
  }

  // Non-object schema fallback: accept any input
  return { _input: z.unknown().optional() } as ZodRawShape;
}

function applyDescription(zodType: ZodTypeAny, description?: string): ZodTypeAny {
  if (description) {
    return zodType.describe(description);
  }
  return zodType;
}

function enumValuesToZod(enumValues: unknown[]): ZodTypeAny {
  if (enumValues.length < 1) {
    return z.unknown();
  }

  if (enumValues.every((val) => typeof val === "string")) {
    const [first, ...rest] = enumValues;
    return z.enum([first, ...rest] as [string, ...string[]]);
  }

  const literalValues = enumValues.filter((val): val is string | number | boolean =>
    ["string", "number", "boolean"].includes(typeof val),
  );
  if (literalValues.length !== enumValues.length) {
    return z.unknown();
  }

  const literalSchemas = literalValues.map((val) => z.literal(val));
  if (literalSchemas.length === 1) {
    return literalSchemas[0];
  }
  const [first, second, ...rest] = literalSchemas;
  return z.union([first, second, ...rest] as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}
