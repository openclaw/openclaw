import { parseLocalSchemaRefPointer } from "@openclaw/normalization-core/json-schema";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TSchema } from "typebox";
import {
  evaluateSchemaWalk,
  walkSchemaArray,
  walkSchemaValue,
  type SchemaWalk,
} from "./schema-walk.js";
import {
  MAX_TOOL_SCHEMA_DEPTH,
  inheritToolSchemaTruncation,
  reportToolSchemaTruncation,
  truncateToolSchemaDepth,
} from "./tool-schema-depth.js";

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

function copySchemaMeta(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of SCHEMA_META_KEYS) {
    if (key in from && from[key] !== undefined) {
      to[key] = from[key];
    }
  }
  return to;
}

// Google requires enum entries as strings even when the declared schema type is numeric or
// boolean. Keep the type intact so tool argument generation and runtime validation still agree.
function cleanGeminiEnumValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .filter(
      (entry) =>
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        (typeof entry === "number" && Number.isFinite(entry)),
    )
    .map(String);
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique : undefined;
}

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
    if (!variantType || (commonType !== null && commonType !== variantType)) {
      return null;
    }
    commonType = variantType;
    allValues.push(literalValue);
  }

  if (commonType && allValues.length > 0) {
    return { type: commonType, enum: allValues };
  }
  return null;
}

function isNullSchema(variant: unknown): boolean {
  if (!isRecord(variant)) {
    return false;
  }
  if ("const" in variant && variant.const === null) {
    return true;
  }
  if (Array.isArray(variant.enum) && variant.enum.length === 1) {
    return variant.enum[0] === null;
  }
  const typeValue = variant.type;
  return (
    typeValue === "null" ||
    (Array.isArray(typeValue) && typeValue.length === 1 && typeValue[0] === "null")
  );
}

type SchemaDefs = Map<string, unknown>;

function extendSchemaDefs(
  defs: SchemaDefs | undefined,
  schema: Record<string, unknown>,
): SchemaDefs | undefined {
  const defsEntry = isRecord(schema.$defs) ? schema.$defs : undefined;
  const legacyDefsEntry = isRecord(schema.definitions) ? schema.definitions : undefined;

  if (!defsEntry && !legacyDefsEntry) {
    return defs;
  }

  const next = new Map(defs);
  for (const entry of [defsEntry, legacyDefsEntry]) {
    for (const [key, value] of Object.entries(entry ?? {})) {
      next.set(key, value);
    }
  }
  return next;
}

function tryResolveLocalRef(ref: string, defs: SchemaDefs | undefined): unknown {
  if (!defs) {
    return undefined;
  }
  const tokens = parseLocalSchemaRefPointer(ref);
  const [table, name] = tokens ?? [];
  if (tokens?.length !== 2 || (table !== "$defs" && table !== "definitions") || !name) {
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

  const nonNullVariants = variants.filter((variant) => !isNullSchema(variant));
  const stripped = nonNullVariants.length !== variants.length;

  const flattened = tryFlattenLiteralAnyOf(nonNullVariants);
  if (flattened) {
    return { kind: "simplified", value: copySchemaMeta(obj, flattened) };
  }

  if (stripped && nonNullVariants.length === 1) {
    const lone = nonNullVariants[0];
    return {
      kind: "simplified",
      value: isRecord(lone) ? copySchemaMeta(obj, { ...lone }) : lone,
    };
  }

  return { kind: "variants", value: stripped ? nonNullVariants : variants };
}

// Gemini rejects object schemas whose `required` entries do not exist in `properties`.
function sanitizeRequiredFields(schema: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(schema.required)) {
    return schema;
  }

  if (!isRecord(schema.properties)) {
    if (schema.type === "object") {
      delete schema.required;
    }
    return schema;
  }

  const properties = schema.properties;
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

function* cleanSchemaForGeminiWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
  ancestors: Set<object>,
  budget: { truncated: boolean },
  depth = 0,
): SchemaWalk {
  if (depth > MAX_TOOL_SCHEMA_DEPTH) {
    budget.truncated = true;
    return {};
  }
  return yield walkSchemaValue(schema, ancestors, function* (obj) {
    const nextDefs = extendSchemaDefs(defs, obj);
    const visit = (value: unknown) =>
      cleanSchemaForGeminiWithDefs(value, nextDefs, refStack, ancestors, budget, depth + 1);

    const refValue = typeof obj.$ref === "string" ? obj.$ref : undefined;
    if (refValue) {
      if (refStack?.has(refValue)) {
        return {};
      }

      const resolved = tryResolveLocalRef(refValue, nextDefs);
      if (resolved) {
        const nextRefStack = new Set(refStack);
        nextRefStack.add(refValue);

        // Reference strings own expansion cycles; raw descent starts a new segment.
        const cleaned = yield cleanSchemaForGeminiWithDefs(
          resolved,
          nextDefs,
          nextRefStack,
          new Set<object>(),
          budget,
          depth + 1,
        );
        if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
          return cleaned;
        }

        return copySchemaMeta(obj, { ...(cleaned as Record<string, unknown>) });
      }

      return copySchemaMeta(obj, {});
    }

    const unions: { anyOf?: unknown[]; oneOf?: unknown[] } = {};
    for (const key of ["anyOf", "oneOf"] as const) {
      const variants = obj[key];
      if (Array.isArray(variants)) {
        const cleaned: unknown[] = [];
        yield walkSchemaArray(variants, visit, cleaned);
        unions[key] = cleaned;
      }
    }
    for (const key of ["anyOf", "oneOf"] as const) {
      const variants = unions[key];
      if (variants) {
        const simplified = simplifyUnionVariants({ obj, variants });
        if (simplified.kind === "simplified") {
          return simplified.value;
        }
        unions[key] = simplified.value;
      }
    }

    const cleaned: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
        continue;
      }

      if (key === "const" || key === "enum") {
        const enumValues = cleanGeminiEnumValues(key === "const" ? [value] : value);
        if (enumValues) {
          cleaned.enum = enumValues;
        }
        continue;
      }

      // Google's schema validator rejects "required": [] — omit empty arrays.
      if (key === "required" && Array.isArray(value) && value.length === 0) {
        continue;
      }

      if (key === "type" && (unions.anyOf || unions.oneOf)) {
        continue;
      }
      if (
        key === "type" &&
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")
      ) {
        const types = value.filter((entry) => entry !== "null");
        cleaned.type = types.length === 1 ? types[0] : types;
        continue;
      }

      if (key === "properties") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const entries = Object.entries(value as Record<string, unknown>);
          for (const entry of entries) {
            entry[1] = yield visit(entry[1]);
          }
          cleaned[key] = Object.fromEntries(entries);
        } else {
          // Malformed property maps must not reach downstream Object.* operations.
          cleaned[key] = {};
        }
      } else if ((key === "items" || key === "allOf") && Array.isArray(value)) {
        cleaned[key] = yield walkSchemaArray(value, visit);
      } else if (key === "items" && value && typeof value === "object") {
        cleaned[key] = yield visit(value);
      } else if ((key === "anyOf" || key === "oneOf") && Array.isArray(value)) {
        cleaned[key] = unions[key];
      } else {
        cleaned[key] = value;
      }
    }

    for (const variants of [cleaned.anyOf, cleaned.oneOf]) {
      if (Array.isArray(variants)) {
        const flattened = flattenUnionFallback(cleaned, variants);
        if (flattened) {
          return sanitizeRequiredFields(flattened);
        }
      }
    }

    return sanitizeRequiredFields(cleaned);
  });
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
  const first = objects[0];
  const type = types.size === 1 ? Array.from(types)[0] : first?.type;
  const merged: Record<string, unknown> =
    objects.length === 1 ? { ...first } : type ? { type } : {};
  return copySchemaMeta(obj, merged);
}

export function cleanSchemaForGemini(schema: unknown, toolName?: string): TSchema {
  const budget = { truncated: false };
  const boundedSchema = truncateToolSchemaDepth(schema, toolName);
  const normalized = evaluateSchemaWalk(
    cleanSchemaForGeminiWithDefs(boundedSchema, undefined, undefined, new Set<object>(), budget),
  ) as TSchema;
  if (budget.truncated) {
    reportToolSchemaTruncation(schema, toolName);
  }
  return inheritToolSchemaTruncation(boundedSchema, normalized, budget.truncated);
}
