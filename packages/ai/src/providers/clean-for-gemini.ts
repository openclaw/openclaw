import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TSchema } from "typebox";
import { evaluateSchemaWalk, type SchemaWalk } from "./schema-walk.js";

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
  if (!isRecord(variant)) {
    return false;
  }
  const record = variant;
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

  const nonNullVariants = variants.filter((variant) => !isNullSchema(variant));
  const stripped = nonNullVariants.length !== variants.length;

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

function* cleanSchemaArray(
  schemas: unknown[],
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
  ancestors: Set<object>,
  result: unknown[],
): SchemaWalk {
  result.length = schemas.length;
  for (let index = 0; index < result.length; index += 1) {
    if (index in schemas) {
      result[index] = yield cleanSchemaForGeminiWithDefs(schemas[index], defs, refStack, ancestors);
    }
  }
  return result;
}

function* cleanSchemaForGeminiWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
  ancestors: Set<object>,
): SchemaWalk {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (ancestors.has(schema)) {
    throw new TypeError("Tool schema contains a circular reference.");
  }
  ancestors.add(schema);
  try {
    if (Array.isArray(schema)) {
      const result: unknown[] = [];
      yield cleanSchemaArray(schema, defs, refStack, ancestors, result);
      return result;
    }

    const obj = schema as Record<string, unknown>;
    const nextDefs = extendSchemaDefs(defs, obj);

    const refValue = typeof obj.$ref === "string" ? obj.$ref : undefined;
    if (refValue) {
      if (refStack?.has(refValue)) {
        return {};
      }

      const resolved = tryResolveLocalRef(refValue, nextDefs);
      if (resolved) {
        const nextRefStack = refStack ? new Set(refStack) : new Set<string>();
        nextRefStack.add(refValue);

        // Reference strings own expansion cycles; raw descent starts a new segment.
        const cleaned = yield cleanSchemaForGeminiWithDefs(
          resolved,
          nextDefs,
          nextRefStack,
          new Set<object>(),
        );
        if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
          return cleaned;
        }

        const result: Record<string, unknown> = {
          ...(cleaned as Record<string, unknown>),
        };
        copySchemaMeta(obj, result);
        return result;
      }

      const result: Record<string, unknown> = {};
      copySchemaMeta(obj, result);
      return result;
    }

    const hasAnyOf = "anyOf" in obj && Array.isArray(obj.anyOf);
    const hasOneOf = "oneOf" in obj && Array.isArray(obj.oneOf);
    let cleanedAnyOf: unknown[] | undefined;
    if (hasAnyOf) {
      const variants = obj.anyOf as unknown[];
      cleanedAnyOf = [];
      yield cleanSchemaArray(variants, nextDefs, refStack, ancestors, cleanedAnyOf);
    }
    let cleanedOneOf: unknown[] | undefined;
    if (hasOneOf) {
      const variants = obj.oneOf as unknown[];
      cleanedOneOf = [];
      yield cleanSchemaArray(variants, nextDefs, refStack, ancestors, cleanedOneOf);
    }

    if (hasAnyOf) {
      const simplified = simplifyUnionVariants({ obj, variants: cleanedAnyOf ?? [] });
      if (simplified.kind === "simplified") {
        return simplified.value;
      }
      cleanedAnyOf = simplified.value;
    }

    if (hasOneOf) {
      const simplified = simplifyUnionVariants({ obj, variants: cleanedOneOf ?? [] });
      if (simplified.kind === "simplified") {
        return simplified.value;
      }
      cleanedOneOf = simplified.value;
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

      if (key === "type" && (hasAnyOf || hasOneOf)) {
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
            entry[1] = yield cleanSchemaForGeminiWithDefs(entry[1], nextDefs, refStack, ancestors);
          }
          cleaned[key] = Object.fromEntries(entries);
        } else {
          // Malformed property maps must not reach downstream Object.* operations.
          cleaned[key] = {};
        }
      } else if (key === "items" && value) {
        if (Array.isArray(value)) {
          const result: unknown[] = [];
          yield cleanSchemaArray(value, nextDefs, refStack, ancestors, result);
          cleaned[key] = result;
        } else if (typeof value === "object") {
          cleaned[key] = yield cleanSchemaForGeminiWithDefs(value, nextDefs, refStack, ancestors);
        } else {
          cleaned[key] = value;
        }
      } else if (key === "anyOf" && Array.isArray(value)) {
        cleaned[key] = cleanedAnyOf;
      } else if (key === "oneOf" && Array.isArray(value)) {
        cleaned[key] = cleanedOneOf;
      } else if (key === "allOf" && Array.isArray(value)) {
        const result: unknown[] = [];
        yield cleanSchemaArray(value, nextDefs, refStack, ancestors, result);
        cleaned[key] = result;
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
  } finally {
    ancestors.delete(schema);
  }
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
  copySchemaMeta(obj, merged);
  return merged;
}

export function cleanSchemaForGemini(schema: unknown): TSchema {
  return evaluateSchemaWalk(
    cleanSchemaForGeminiWithDefs(schema, undefined, undefined, new Set<object>()),
  ) as TSchema;
}
