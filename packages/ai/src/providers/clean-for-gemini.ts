// Cloud Code Assist API rejects a subset of JSON Schema keywords.
// This module scrubs/normalizes tool schemas to keep Gemini happy.

import type { TSchema } from "typebox";

// Keywords that Cloud Code Assist API rejects (not compliant with their JSON Schema subset)
export const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  // Serialized optional-property metadata is not part of Google's Schema message.
  "~optional",
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  // Non-standard (OpenAPI) keyword; Claude validators reject it.
  "examples",

  // Cloud Code Assist appears to validate tool schemas more strictly/quirkily than
  // draft 2020-12 in practice; these constraints frequently trigger 400s.
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",

  // JSON Schema composition keywords not supported by OpenAPI 3.0 subset.
  // `const` is handled separately (converted to enum) in the cleaning loop,
  // but `not` has no safe equivalent and must be stripped.
  "not",
]);

const SCHEMA_META_KEYS = ["description", "title", "default"] as const;

function copySchemaMeta(from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of SCHEMA_META_KEYS) {
    if (key in from && from[key] !== undefined) {
      to[key] = from[key];
    }
  }
}

// Google requires enum entries as strings even when the declared schema type is numeric or
// boolean. Keep the type intact so tool argument generation and runtime validation still agree.
function stringifyGeminiEnumValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function cleanGeminiEnumValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.flatMap((entry) => {
    const stringified = stringifyGeminiEnumValue(entry);
    return stringified === undefined ? [] : [stringified];
  });
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique : undefined;
}

// Check if an anyOf/oneOf array contains only literal values that can be flattened.
// TypeBox Type.Literal generates { const: "value", type: "string" }.
// Some schemas may use { enum: ["value"], type: "string" }.
// Both patterns are flattened to { type: "string", enum: ["a", "b", ...] }.
function tryFlattenLiteralAnyOf(variants: unknown[]): { type: string; enum: unknown[] } | null {
  if (variants.length === 0) {
    return null;
  }

  const allValues: unknown[] = [];
  let commonType: string | null = null;

  for (const variant of variants) {
    if (!variant || typeof variant !== "object") {
      return null;
    }
    const v = variant as Record<string, unknown>;

    let literalValue: unknown;
    if ("const" in v) {
      literalValue = v.const;
    } else if (Array.isArray(v.enum) && v.enum.length === 1) {
      literalValue = v.enum[0];
    } else {
      return null;
    }

    const variantType = typeof v.type === "string" ? v.type : null;
    if (!variantType) {
      return null;
    }
    if (commonType === null) {
      commonType = variantType;
    } else if (commonType !== variantType) {
      return null;
    }

    allValues.push(literalValue);
  }

  if (commonType && allValues.length > 0) {
    return { type: commonType, enum: allValues };
  }
  return null;
}

function isNullSchema(variant: unknown): boolean {
  if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
    return false;
  }
  const record = variant as Record<string, unknown>;
  if ("const" in record && record.const === null) {
    return true;
  }
  if (Array.isArray(record.enum) && record.enum.length === 1) {
    return record.enum[0] === null;
  }
  const typeValue = record.type;
  if (typeValue === "null") {
    return true;
  }
  if (Array.isArray(typeValue) && typeValue.length === 1 && typeValue[0] === "null") {
    return true;
  }
  return false;
}

function stripNullVariants(variants: unknown[]): {
  variants: unknown[];
  stripped: boolean;
} {
  if (variants.length === 0) {
    return { variants, stripped: false };
  }
  const nonNull = variants.filter((variant) => !isNullSchema(variant));
  return {
    variants: nonNull,
    stripped: nonNull.length !== variants.length,
  };
}

type SchemaDefs = Map<string, unknown>;

function extendSchemaDefs(
  defs: SchemaDefs | undefined,
  schema: Record<string, unknown>,
): SchemaDefs | undefined {
  const defsEntry =
    schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
      ? (schema.$defs as Record<string, unknown>)
      : undefined;
  const legacyDefsEntry =
    schema.definitions &&
    typeof schema.definitions === "object" &&
    !Array.isArray(schema.definitions)
      ? (schema.definitions as Record<string, unknown>)
      : undefined;

  if (!defsEntry && !legacyDefsEntry) {
    return defs;
  }

  const next = defs ? new Map(defs) : new Map<string, unknown>();
  if (defsEntry) {
    for (const [key, value] of Object.entries(defsEntry)) {
      next.set(key, value);
    }
  }
  if (legacyDefsEntry) {
    for (const [key, value] of Object.entries(legacyDefsEntry)) {
      next.set(key, value);
    }
  }
  return next;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function tryResolveLocalRef(ref: string, defs: SchemaDefs | undefined): unknown {
  if (!defs) {
    return undefined;
  }
  const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const name = decodeJsonPointerSegment(match[1] ?? "");
  if (!name) {
    return undefined;
  }
  return defs.get(name);
}

function simplifyUnionVariants(params: { obj: Record<string, unknown>; variants: unknown[] }):
  | {
      kind: "simplified";
      value: unknown;
    }
  | {
      kind: "variants";
      value: unknown[];
    } {
  const { obj, variants } = params;

  const { variants: nonNullVariants, stripped } = stripNullVariants(variants);

  const flattened = tryFlattenLiteralAnyOf(nonNullVariants);
  if (flattened) {
    const result: Record<string, unknown> = {
      type: flattened.type,
      enum: flattened.enum,
    };
    copySchemaMeta(obj, result);
    return { kind: "simplified", value: result };
  }

  if (stripped && nonNullVariants.length === 1) {
    const lone = nonNullVariants[0];
    if (lone && typeof lone === "object" && !Array.isArray(lone)) {
      const result: Record<string, unknown> = {
        ...(lone as Record<string, unknown>),
      };
      copySchemaMeta(obj, result);
      return { kind: "simplified", value: result };
    }
    return { kind: "simplified", value: lone };
  }

  return { kind: "variants", value: stripped ? nonNullVariants : variants };
}

// Gemini rejects object schemas whose `required` entries do not exist in `properties`.
function sanitizeRequiredFields(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.required)) {
    return schema;
  }

  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    if (schema.type === "object") {
      delete schema.required;
    }
    return schema;
  }

  const properties = schema.properties as Record<string, unknown>;
  const required = schema.required.filter(
    (key): key is string => typeof key === "string" && Object.hasOwn(properties, key),
  );

  if (required.length > 0) {
    schema.required = required;
  } else {
    delete schema.required;
  }

  return schema;
}

// Tool schemas are external input and can nest far deeper than the call stack, so this walker
// runs an explicit task stack instead of recursing (#141306). A visit task either resolves a
// leaf immediately or pushes assemble tasks plus a visit task per child; each assemble task
// only runs after its children have written their results back, mirroring the original
// recursion's anyOf/oneOf-then-body ordering.
type GeminiVisitTask = {
  kind: "visit";
  node: unknown;
  defs: SchemaDefs | undefined;
  refStack: Set<string> | undefined;
  assign: (value: unknown) => void;
};

type GeminiAssembleArrayTask = {
  kind: "assemble-array";
  node: object;
  assign: (value: unknown) => void;
  entries: unknown[];
};

// Runs once the resolved $ref target is cleaned: merge in the referencing node's metadata.
type GeminiAssembleRefTask = {
  kind: "assemble-ref";
  node: object;
  assign: (value: unknown) => void;
  obj: Record<string, unknown>;
  resolved: unknown;
};

// Runs once anyOf/oneOf variants are cleaned: simplify unions, then plan the body walk.
type GeminiAssembleUnionsTask = {
  kind: "assemble-unions";
  node: object;
  assign: (value: unknown) => void;
  obj: Record<string, unknown>;
  nextDefs: SchemaDefs | undefined;
  refStack: Set<string> | undefined;
  hasAnyOf: boolean;
  hasOneOf: boolean;
  cleanedAnyOf: unknown[] | undefined;
  cleanedOneOf: unknown[] | undefined;
};

// Runs once the body's child schemas are cleaned: apply union fallbacks and sanitize required.
type GeminiAssembleRecordTask = {
  kind: "assemble-record";
  node: object;
  assign: (value: unknown) => void;
  // Body entries in source order; child results write back through the entry, and the cleaned
  // record is built in plan order at assemble time so key insertion order (including the
  // const-before-enum overwrite) matches the recursion exactly.
  plan: Array<
    | { kind: "write"; key: string; value: unknown }
    // `properties` maps rebuild through Object.fromEntries so user-named keys such as
    // `__proto__` become own properties, matching the recursion.
    | { kind: "props"; key: string; entries: Array<[string, unknown]> }
    | { kind: "child"; key: string; value: unknown }
    | { kind: "child-array"; key: string; entries: unknown[] }
  >;
};

type GeminiTask =
  | GeminiVisitTask
  | GeminiAssembleArrayTask
  | GeminiAssembleRefTask
  | GeminiAssembleUnionsTask
  | GeminiAssembleRecordTask;

function createCircularToolSchemaError(): TypeError {
  return new TypeError("Tool schema contains a circular reference and cannot be normalized.");
}

function cleanSchemaForGeminiTree(schema: unknown): unknown {
  let rootResult: unknown = schema;
  // Recursion previously bounded cyclic object graphs via the call stack; the explicit stack
  // removes that implicit guard, so the walk tracks the nodes on its current path instead.
  const ancestors = new Set<object>();
  const tasks: GeminiTask[] = [
    {
      kind: "visit",
      node: schema,
      defs: undefined,
      refStack: undefined,
      assign: (value) => {
        rootResult = value;
      },
    },
  ];
  let task: GeminiTask | undefined;
  while ((task = tasks.pop()) !== undefined) {
    if (task.kind === "assemble-array") {
      ancestors.delete(task.node);
      task.assign(task.entries);
      continue;
    }
    if (task.kind === "assemble-ref") {
      ancestors.delete(task.node);
      const cleaned = task.resolved;
      if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
        task.assign(cleaned);
        continue;
      }
      const result: Record<string, unknown> = {
        ...(cleaned as Record<string, unknown>),
      };
      copySchemaMeta(task.obj, result);
      task.assign(result);
      continue;
    }
    if (task.kind === "assemble-record") {
      ancestors.delete(task.node);
      const cleaned: Record<string, unknown> = {};
      for (const entry of task.plan) {
        if (entry.kind === "write") {
          cleaned[entry.key] = entry.value;
        } else if (entry.kind === "props") {
          cleaned[entry.key] = Object.fromEntries(entry.entries);
        } else if (entry.kind === "child") {
          cleaned[entry.key] = entry.value;
        } else {
          cleaned[entry.key] = entry.entries;
        }
      }
      // Cloud Code Assist API rejects anyOf/oneOf in nested schemas even after
      // simplifyUnionVariants runs above. Flatten remaining unions as a fallback:
      // pick the common type or use the first variant's type so the tool
      // declaration is accepted by Google's validation layer.
      if (cleaned.anyOf && Array.isArray(cleaned.anyOf)) {
        const flattened = flattenUnionFallback(cleaned, cleaned.anyOf);
        if (flattened) {
          task.assign(sanitizeRequiredFields(flattened));
          continue;
        }
      }
      if (cleaned.oneOf && Array.isArray(cleaned.oneOf)) {
        const flattened = flattenUnionFallback(cleaned, cleaned.oneOf);
        if (flattened) {
          task.assign(sanitizeRequiredFields(flattened));
          continue;
        }
      }
      task.assign(sanitizeRequiredFields(cleaned));
      continue;
    }
    if (task.kind === "assemble-unions") {
      const { obj, nextDefs, refStack, hasAnyOf, hasOneOf, assign } = task;
      let cleanedAnyOf = task.cleanedAnyOf;
      let cleanedOneOf = task.cleanedOneOf;
      if (hasAnyOf) {
        const simplified = simplifyUnionVariants({ obj, variants: cleanedAnyOf ?? [] });
        if (simplified.kind === "simplified") {
          ancestors.delete(task.node);
          assign(simplified.value);
          continue;
        }
        cleanedAnyOf = simplified.value;
      }
      if (hasOneOf) {
        const simplified = simplifyUnionVariants({ obj, variants: cleanedOneOf ?? [] });
        if (simplified.kind === "simplified") {
          ancestors.delete(task.node);
          assign(simplified.value);
          continue;
        }
        cleanedOneOf = simplified.value;
      }

      const plan: GeminiAssembleRecordTask["plan"] = [];
      const children: GeminiVisitTask[] = [];

      for (const [key, value] of Object.entries(obj)) {
        if (GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
          continue;
        }

        if (key === "const") {
          const enumValues = cleanGeminiEnumValues([value]);
          if (enumValues) {
            plan.push({ kind: "write", key: "enum", value: enumValues });
          }
          continue;
        }

        if (key === "enum") {
          const enumValues = cleanGeminiEnumValues(value);
          if (enumValues) {
            plan.push({ kind: "write", key: "enum", value: enumValues });
          }
          continue;
        }

        // Google's schema validator rejects `"required": []` — omit empty arrays.
        if (key === "required" && Array.isArray(value) && value.length === 0) {
          continue;
        }

        if (key === "type" && (hasAnyOf || hasOneOf)) {
          continue;
        }
        if (
          key === "type" &&
          Array.isArray(value) &&
          value.every((entry) => typeof entry === "string")
        ) {
          const types = value.filter((entry) => entry !== "null");
          plan.push({ kind: "write", key: "type", value: types.length === 1 ? types[0] : types });
          continue;
        }

        if (key === "properties") {
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const planEntry: Extract<GeminiAssembleRecordTask["plan"][number], { kind: "props" }> =
              { kind: "props", key, entries: [] };
            plan.push(planEntry);
            for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
              children.push({
                kind: "visit",
                node: childValue,
                defs: nextDefs,
                refStack,
                assign: (childResult) => {
                  planEntry.entries.push([childKey, childResult]);
                },
              });
            }
          } else {
            // Guard malformed schemas (e.g. properties: null) that can trigger
            // downstream Object.* crashes in strict provider validators.
            plan.push({ kind: "write", key, value: {} });
          }
          continue;
        }
        if (key === "items" && value) {
          if (Array.isArray(value)) {
            const planEntry: Extract<
              GeminiAssembleRecordTask["plan"][number],
              { kind: "child-array" }
            > = { kind: "child-array", key, entries: Array.from({ length: value.length }) };
            plan.push(planEntry);
            value.forEach((entry, index) => {
              children.push({
                kind: "visit",
                node: entry,
                defs: nextDefs,
                refStack,
                assign: (childResult) => {
                  planEntry.entries[index] = childResult;
                },
              });
            });
          } else if (typeof value === "object") {
            const planEntry: Extract<GeminiAssembleRecordTask["plan"][number], { kind: "child" }> =
              { kind: "child", key, value: undefined };
            plan.push(planEntry);
            children.push({
              kind: "visit",
              node: value,
              defs: nextDefs,
              refStack,
              assign: (childResult) => {
                planEntry.value = childResult;
              },
            });
          } else {
            plan.push({ kind: "write", key, value });
          }
          continue;
        }
        if (key === "anyOf" && Array.isArray(value)) {
          // Variants were already cleaned before union simplification; cleanedAnyOf is
          // always set here because hasAnyOf guards the same condition.
          plan.push({ kind: "write", key, value: cleanedAnyOf ?? value });
          continue;
        }
        if (key === "oneOf" && Array.isArray(value)) {
          plan.push({ kind: "write", key, value: cleanedOneOf ?? value });
          continue;
        }
        if (key === "allOf" && Array.isArray(value)) {
          const planEntry: Extract<
            GeminiAssembleRecordTask["plan"][number],
            { kind: "child-array" }
          > = { kind: "child-array", key, entries: Array.from({ length: value.length }) };
          plan.push(planEntry);
          value.forEach((entry, index) => {
            children.push({
              kind: "visit",
              node: entry,
              defs: nextDefs,
              refStack,
              assign: (childResult) => {
                planEntry.entries[index] = childResult;
              },
            });
          });
          continue;
        }
        plan.push({ kind: "write", key, value });
      }

      tasks.push({
        kind: "assemble-record",
        node: task.node,
        assign,
        plan,
      });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) {
          tasks.push(child);
        }
      }
      continue;
    }

    // visit
    const { node, defs, refStack, assign } = task;
    if (!node || typeof node !== "object") {
      assign(node);
      continue;
    }
    if (ancestors.has(node)) {
      throw createCircularToolSchemaError();
    }
    ancestors.add(node);
    if (Array.isArray(node)) {
      const entries: unknown[] = Array.from({ length: node.length });
      tasks.push({ kind: "assemble-array", node, assign, entries });
      for (let index = node.length - 1; index >= 0; index -= 1) {
        const slot = index;
        tasks.push({
          kind: "visit",
          node: node[slot],
          defs,
          refStack,
          assign: (value) => {
            entries[slot] = value;
          },
        });
      }
      continue;
    }

    const obj = node as Record<string, unknown>;
    const nextDefs = extendSchemaDefs(defs, obj);

    const refValue = typeof obj.$ref === "string" ? obj.$ref : undefined;
    if (refValue) {
      if (refStack?.has(refValue)) {
        ancestors.delete(node);
        assign({});
        continue;
      }

      const resolved = tryResolveLocalRef(refValue, nextDefs);
      if (resolved) {
        const nextRefStack = refStack ? new Set(refStack) : new Set<string>();
        nextRefStack.add(refValue);
        const refTask: GeminiAssembleRefTask = {
          kind: "assemble-ref",
          node,
          assign,
          obj,
          resolved: undefined,
        };
        tasks.push(refTask);
        tasks.push({
          kind: "visit",
          node: resolved,
          defs: nextDefs,
          refStack: nextRefStack,
          assign: (value) => {
            refTask.resolved = value;
          },
        });
        continue;
      }

      ancestors.delete(node);
      const result: Record<string, unknown> = {};
      copySchemaMeta(obj, result);
      assign(result);
      continue;
    }

    const hasAnyOf = "anyOf" in obj && Array.isArray(obj.anyOf);
    const hasOneOf = "oneOf" in obj && Array.isArray(obj.oneOf);
    const anyOfVariants = hasAnyOf ? (obj.anyOf as unknown[]) : undefined;
    const oneOfVariants = hasOneOf ? (obj.oneOf as unknown[]) : undefined;
    const cleanedAnyOf = anyOfVariants
      ? Array.from<unknown>({ length: anyOfVariants.length })
      : undefined;
    const cleanedOneOf = oneOfVariants
      ? Array.from<unknown>({ length: oneOfVariants.length })
      : undefined;

    tasks.push({
      kind: "assemble-unions",
      node,
      assign,
      obj,
      nextDefs,
      refStack,
      hasAnyOf,
      hasOneOf,
      cleanedAnyOf,
      cleanedOneOf,
    });
    if (oneOfVariants && cleanedOneOf) {
      const target = cleanedOneOf;
      for (let index = oneOfVariants.length - 1; index >= 0; index -= 1) {
        const slot = index;
        tasks.push({
          kind: "visit",
          node: oneOfVariants[slot],
          defs: nextDefs,
          refStack,
          assign: (value) => {
            target[slot] = value;
          },
        });
      }
    }
    if (anyOfVariants && cleanedAnyOf) {
      const target = cleanedAnyOf;
      for (let index = anyOfVariants.length - 1; index >= 0; index -= 1) {
        const slot = index;
        tasks.push({
          kind: "visit",
          node: anyOfVariants[slot],
          defs: nextDefs,
          refStack,
          assign: (value) => {
            target[slot] = value;
          },
        });
      }
    }
  }
  return rootResult;
}

export function cleanSchemaForGemini(schema: unknown): TSchema {
  return cleanSchemaForGeminiTree(schema) as TSchema;
}

/**
 * Last-resort flattening for anyOf/oneOf arrays that could not be simplified
 * by `simplifyUnionVariants`. Picks a representative type so the schema is
 * accepted by Google's restricted JSON Schema validation.
 */
function flattenUnionFallback(
  obj: Record<string, unknown>,
  variants: unknown[],
): Record<string, unknown> | undefined {
  const objects = variants.filter(
    (v): v is Record<string, unknown> => Boolean(v) && typeof v === "object",
  );
  if (objects.length === 0) {
    return undefined;
  }
  const types = new Set(objects.map((v) => v.type).filter(Boolean));
  if (objects.length === 1) {
    const merged: Record<string, unknown> = { ...objects[0] };
    copySchemaMeta(obj, merged);
    return merged;
  }
  if (types.size === 1) {
    const merged: Record<string, unknown> = { type: Array.from(types)[0] };
    copySchemaMeta(obj, merged);
    return merged;
  }
  const first = objects[0];
  if (first?.type) {
    const merged: Record<string, unknown> = { type: first.type };
    copySchemaMeta(obj, merged);
    return merged;
  }
  const merged: Record<string, unknown> = {};
  copySchemaMeta(obj, merged);
  return merged;
}
