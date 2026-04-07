/**
 * MCP Schema Sanitization Module
 *
 * Responsible for inlining $ref/$defs references and removing JSON Schema keywords
 * unsupported by Gemini, preventing 400 errors when Gemini parses function responses.
 */

/** JSON Schema keywords unsupported by Gemini */
const GEMINI_UNSUPPORTED_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
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

/**
 * Sanitize JSON Schema by inlining $ref references and removing keywords
 * unsupported by Gemini, preventing 400 errors when Gemini parses function responses.
 */
export function cleanSchemaForGemini(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(cleanSchemaForGemini);
  }

  const obj = schema as Record<string, unknown>;

  // Collect $defs/definitions for subsequent $ref inline resolution
  const defs: Record<string, unknown> = {
    ...(obj.$defs && typeof obj.$defs === "object" ? (obj.$defs as Record<string, unknown>) : {}),
    ...(obj.definitions && typeof obj.definitions === "object"
      ? (obj.definitions as Record<string, unknown>)
      : {}),
  };

  return cleanWithDefs(obj, defs, new Set());
}

function cleanWithDefs(
  schema: unknown,
  defs: Record<string, unknown>,
  refStack: Set<string>,
): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((item) => cleanWithDefs(item, defs, refStack));
  }

  const obj = schema as Record<string, unknown>;

  // Merge current level's $defs/definitions into defs
  if (obj.$defs && typeof obj.$defs === "object") {
    Object.assign(defs, obj.$defs as Record<string, unknown>);
  }
  if (obj.definitions && typeof obj.definitions === "object") {
    Object.assign(defs, obj.definitions as Record<string, unknown>);
  }

  // Handle $ref references: attempt inline resolution
  if (typeof obj.$ref === "string") {
    const ref = obj.$ref;
    if (refStack.has(ref)) {
      return {};
    } // Prevent circular references

    const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
    if (match && match[1] && defs[match[1]]) {
      const nextStack = new Set(refStack);
      nextStack.add(ref);
      return cleanWithDefs(defs[match[1]], defs, nextStack);
    }
    return {}; // Unresolvable $ref, return empty object
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (GEMINI_UNSUPPORTED_KEYWORDS.has(key)) {
      continue;
    }

    if (key === "const") {
      cleaned.enum = [value];
      continue;
    }

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          cleanWithDefs(v, defs, refStack),
        ]),
      );
    } else if (key === "items" && value) {
      cleaned[key] = Array.isArray(value)
        ? value.map((item) => cleanWithDefs(item, defs, refStack))
        : cleanWithDefs(value, defs, refStack);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      // Filter out null type variants
      const nonNull = value.filter((v) => {
        if (!v || typeof v !== "object") {
          return true;
        }
        const r = v as Record<string, unknown>;
        return r.type !== "null";
      });
      if (nonNull.length === 1) {
        // Only one variant left, inline directly
        const single = cleanWithDefs(nonNull[0], defs, refStack);
        if (single && typeof single === "object" && !Array.isArray(single)) {
          Object.assign(cleaned, single as Record<string, unknown>);
        }
      } else {
        cleaned[key] = nonNull.map((v) => cleanWithDefs(v, defs, refStack));
      }
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}
