import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type, type TSchema } from "typebox";

const INPUT_DISCRIMINATOR = "x-openclaw-input-discriminator";
const MAX_REFERENCE_SCAN_NODES = 4096;
const MAX_REFERENCE_SCAN_DEPTH = 64;
const SCHEMA_MAP_KEYS = [
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
];
const SCHEMA_VALUE_KEYS = [
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "oneOf",
  "prefixItems",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];

function canNarrowOutputSchema(schema: unknown): boolean {
  let remaining = MAX_REFERENCE_SCAN_NODES;
  const active = new WeakSet<object>();
  const completedSchemas = new WeakSet<object>();
  const completedContainers = new WeakSet<object>();
  const visit = (value: unknown, depth: number, map = false): boolean => {
    if (--remaining < 0 || depth > MAX_REFERENCE_SCAN_DEPTH) {
      return false;
    }
    if (value === null || typeof value !== "object") {
      return true;
    }
    if (active.has(value)) {
      return false;
    }
    const completed = map || Array.isArray(value) ? completedContainers : completedSchemas;
    if (completed.has(value)) {
      return true;
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (!visit(child, depth + 1)) {
            return false;
          }
        }
      } else if (isRecord(value)) {
        if (map) {
          for (const key in value) {
            if (--remaining < 0 || (Object.hasOwn(value, key) && !visit(value[key], depth + 1))) {
              return false;
            }
          }
        } else {
          if (["$ref", "$dynamicRef", "$recursiveRef"].some((key) => Object.hasOwn(value, key))) {
            return false;
          }
          for (const key of SCHEMA_MAP_KEYS) {
            if (Object.hasOwn(value, key) && !visit(value[key], depth + 1, true)) {
              return false;
            }
          }
          for (const key of SCHEMA_VALUE_KEYS) {
            if (Object.hasOwn(value, key) && !visit(value[key], depth + 1)) {
              return false;
            }
          }
        }
      }
      completed.add(value);
      return true;
    } finally {
      active.delete(value);
    }
  };
  return visit(schema, 0);
}

/** Derive the complete output union and its input-dependent branches together. */
export function defineToolOutputSchema(options: {
  inputProperty: string;
  variants: Readonly<Record<string, TSchema>>;
}) {
  const variants: TSchema[] = [];
  const mapping: Record<string, number> = Object.fromEntries(
    Object.entries(options.variants).map(([value, schema]) => {
      let index = variants.indexOf(schema);
      if (index === -1) {
        index = variants.push(schema) - 1;
      }
      return [value, index];
    }),
  );
  if (!options.inputProperty || variants.length === 0) {
    throw new TypeError("Tool output variants require an input property and at least one branch.");
  }
  return Type.Union(variants, {
    [INPUT_DISCRIMINATOR]: { version: 1, inputProperty: options.inputProperty, mapping },
  });
}

/** Read the annotation and conservatively determine whether its branches can be narrowed. */
export function readToolOutputSchemaVariants(schema: unknown):
  | {
      inputProperty: string;
      mapping: ReadonlyMap<string, number>;
      variants: readonly unknown[];
      canNarrow: boolean;
    }
  | undefined {
  if (!isRecord(schema) || !Object.hasOwn(schema, INPUT_DISCRIMINATOR)) {
    return undefined;
  }
  const annotation = schema[INPUT_DISCRIMINATOR];
  if (
    !isRecord(annotation) ||
    annotation.version !== 1 ||
    typeof annotation.inputProperty !== "string" ||
    !annotation.inputProperty ||
    !isRecord(annotation.mapping) ||
    !Array.isArray(schema.anyOf) ||
    schema.anyOf.length === 0
  ) {
    throw new TypeError("Invalid tool output input-discriminator annotation.");
  }
  const mapping = new Map<string, number>();
  for (const [value, index] of Object.entries(annotation.mapping)) {
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= schema.anyOf.length
    ) {
      throw new TypeError("Invalid tool output input-discriminator branch.");
    }
    mapping.set(value, index);
  }
  if (mapping.size === 0) {
    throw new TypeError("Tool output input-discriminator mapping must not be empty.");
  }
  return {
    inputProperty: annotation.inputProperty,
    mapping,
    variants: schema.anyOf,
    canNarrow: canNarrowOutputSchema(schema),
  };
}

export type ToolOutputSelection = { inputProperty: string; value: string | undefined };

export function captureToolOutputSelection(
  inputProperty: string,
  input: unknown,
): ToolOutputSelection {
  const value =
    isRecord(input) && Object.hasOwn(input, inputProperty) ? input[inputProperty] : undefined;
  return { inputProperty, value: typeof value === "string" ? value : undefined };
}

/** Missing, dynamic, or unmapped input values retain the complete output contract. */
export function selectToolOutputSchema(schema: unknown, input: unknown): unknown {
  if (!isRecord(schema)) {
    return schema;
  }
  const discriminator = readToolOutputSchemaVariants(schema);
  if (!discriminator?.canNarrow) {
    return schema;
  }
  const { value } = captureToolOutputSelection(discriminator.inputProperty, input);
  const index = value === undefined ? undefined : discriminator.mapping.get(value);
  if (index === undefined) {
    return schema;
  }
  if (schema.allOf !== undefined && !Array.isArray(schema.allOf)) {
    throw new TypeError("Invalid tool output allOf constraint.");
  }
  // Reference-bearing schemas retain their original root, including recursive alternatives.
  // Reference-free schemas can be narrowed while preserving every other root constraint.
  return { ...schema, allOf: [...(schema.allOf ?? []), { $ref: `#/anyOf/${index}` }] };
}
