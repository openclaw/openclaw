// Cloud Code Assist API rejects a subset of JSON Schema keywords.
// This module scrubs/normalizes tool schemas to keep Gemini happy.

// Keywords that Cloud Code Assist API rejects (not compliant with their JSON Schema subset)
export const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
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
]);

const SCHEMA_META_KEYS = ["description", "title", "default"] as const;

function copySchemaMeta(from: Record<string, unknown>, to: Record<string, unknown>): void {
  for (const key of SCHEMA_META_KEYS) {
    if (key in from && from[key] !== undefined) {
      to[key] = from[key];
    }
  }
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

function simplifyUnionVariants(params: { obj: Record<string, unknown>; variants: unknown[] }): {
  variants: unknown[];
  simplified?: unknown;
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
    return { variants: nonNullVariants, simplified: result };
  }

  if (stripped && nonNullVariants.length === 1) {
    const lone = nonNullVariants[0];
    if (lone && typeof lone === "object" && !Array.isArray(lone)) {
      const result: Record<string, unknown> = {
        ...(lone as Record<string, unknown>),
      };
      copySchemaMeta(obj, result);
      return { variants: nonNullVariants, simplified: result };
    }
    return { variants: nonNullVariants, simplified: lone };
  }

  return { variants: stripped ? nonNullVariants : variants };
}

function cleanSchemaForGeminiWithDefs(
  schema: unknown,
  defs: SchemaDefs | undefined,
  refStack: Set<string> | undefined,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanSchemaForGeminiWithDefs(item, defs, refStack));
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

      const cleaned = cleanSchemaForGeminiWithDefs(resolved, nextDefs, nextRefStack);
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
  let cleanedAnyOf = hasAnyOf
    ? (obj.anyOf as unknown[]).map((variant) =>
        cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack),
      )
    : undefined;
  let cleanedOneOf = hasOneOf
    ? (obj.oneOf as unknown[]).map((variant) =>
        cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack),
      )
    : undefined;

  if (hasAnyOf) {
    const simplified = simplifyUnionVariants({ obj, variants: cleanedAnyOf ?? [] });
    cleanedAnyOf = simplified.variants;
    if ("simplified" in simplified) {
      return simplified.simplified;
    }
  }

  if (hasOneOf) {
    const simplified = simplifyUnionVariants({ obj, variants: cleanedOneOf ?? [] });
    cleanedOneOf = simplified.variants;
    if ("simplified" in simplified) {
      return simplified.simplified;
    }
  }

  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }

    if (key === "const") {
      cleaned.enum = [value];
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

    if (key === "properties" && value && typeof value === "object") {
      const props = value as Record<string, unknown>;
      cleaned[key] = Object.fromEntries(
        Object.entries(props).map(([k, v]) => [
          k,
          cleanSchemaForGeminiWithDefs(v, nextDefs, refStack),
        ]),
      );
    } else if (key === "items" && value) {
      if (Array.isArray(value)) {
        cleaned[key] = value.map((entry) =>
          cleanSchemaForGeminiWithDefs(entry, nextDefs, refStack),
        );
      } else if (typeof value === "object") {
        cleaned[key] = cleanSchemaForGeminiWithDefs(value, nextDefs, refStack);
      } else {
        cleaned[key] = value;
      }
    } else if (key === "anyOf" && Array.isArray(value)) {
      cleaned[key] =
        cleanedAnyOf ??
        value.map((variant) => cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack));
    } else if (key === "oneOf" && Array.isArray(value)) {
      cleaned[key] =
        cleanedOneOf ??
        value.map((variant) => cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack));
    } else if (key === "allOf" && Array.isArray(value)) {
      cleaned[key] = value.map((variant) =>
        cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack),
      );
    } else {
      cleaned[key] = value;
    }
  }

  // Cloud Code Assist API also rejects anyOf/oneOf in nested schemas.
  // If simplifyUnionVariants couldn't reduce the union above, flatten it
  // here as a fallback: pick the first variant's type or use a permissive
  // schema so the tool declaration is accepted.
  if (cleaned.anyOf && Array.isArray(cleaned.anyOf)) {
    const variants = (cleaned.anyOf as Record<string, unknown>[]).filter(
      (v) => v && typeof v === "object",
    );
    const types = new Set(variants.map((v) => v.type).filter(Boolean));
    if (variants.length === 1) {
      const merged: Record<string, unknown> = { ...variants[0] };
      copySchemaMeta(cleaned, merged);
      return merged;
    }
    if (types.size === 1) {
      const merged: Record<string, unknown> = { type: Array.from(types)[0] };
      copySchemaMeta(cleaned, merged);
      return merged;
    }
    // Mixed types (e.g. string | array<string>): use first variant's type.
    // The execute function already handles type coercion at runtime.
    const first = variants[0];
    if (first?.type) {
      const merged: Record<string, unknown> = { type: first.type };
      copySchemaMeta(cleaned, merged);
      return merged;
    }
    const merged: Record<string, unknown> = {};
    copySchemaMeta(cleaned, merged);
    return merged;
  }

  if (cleaned.oneOf && Array.isArray(cleaned.oneOf)) {
    const variants = (cleaned.oneOf as Record<string, unknown>[]).filter(
      (v) => v && typeof v === "object",
    );
    const types = new Set(variants.map((v) => v.type).filter(Boolean));
    if (variants.length === 1) {
      const merged: Record<string, unknown> = { ...variants[0] };
      copySchemaMeta(cleaned, merged);
      return merged;
    }
    if (types.size === 1) {
      const merged: Record<string, unknown> = { type: Array.from(types)[0] };
      copySchemaMeta(cleaned, merged);
      return merged;
    }
    const first = variants[0];
    if (first?.type) {
      const merged: Record<string, unknown> = { type: first.type };
      copySchemaMeta(cleaned, merged);
      return merged;
    }
    const merged: Record<string, unknown> = {};
    copySchemaMeta(cleaned, merged);
    return merged;
  }

  return cleaned;
}

export function cleanSchemaForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(cleanSchemaForGemini);
  }

  const defs = extendSchemaDefs(undefined, schema as Record<string, unknown>);
  return cleanSchemaForGeminiWithDefs(schema, defs, undefined);
}
