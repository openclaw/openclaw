// Normalizes JSON Schema tool parameters into the shape the native Ollama chat API expects.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function inferOllamaSchemaType(schema: Record<string, unknown>): string | undefined {
  if (schema.properties && isRecord(schema.properties)) {
    return "object";
  }
  if (schema.items) {
    return "array";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum.filter((value) => value !== null);
    if (values.length > 0 && values.every((value) => typeof value === "string")) {
      return "string";
    }
    if (values.length > 0 && values.every((value) => typeof value === "number")) {
      return "number";
    }
    if (values.length > 0 && values.every((value) => typeof value === "boolean")) {
      return "boolean";
    }
  }
  for (const unionKey of ["anyOf", "oneOf"] as const) {
    const variants = schema[unionKey];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      if (!isRecord(variant)) {
        continue;
      }
      const variantType = variant.type;
      if (typeof variantType === "string" && variantType !== "null") {
        return variantType;
      }
      if (Array.isArray(variantType)) {
        const firstType = variantType.find(
          (entry): entry is string => typeof entry === "string" && entry !== "null",
        );
        if (firstType) {
          return firstType;
        }
      }
      const inferred = inferOllamaSchemaType(variant);
      if (inferred) {
        return inferred;
      }
    }
  }
  return undefined;
}

export function normalizeOllamaToolSchema(
  schema: unknown,
  isRoot = false,
): Record<string, unknown> {
  if (!isRecord(schema)) {
    return {
      type: "object",
      properties: {},
    };
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isRecord(value)) {
      normalized.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [
          propertyName,
          normalizeOllamaToolSchema(propertySchema),
        ]),
      );
      continue;
    }
    if (key === "items") {
      normalized.items = Array.isArray(value)
        ? value.map((entry) => normalizeOllamaToolSchema(entry))
        : normalizeOllamaToolSchema(value);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      normalized[key] = value.map((entry) => normalizeOllamaToolSchema(entry));
      continue;
    }
    normalized[key] = value;
  }

  const schemaType = normalized.type;
  if (
    typeof schemaType !== "string" &&
    (!Array.isArray(schemaType) ||
      !schemaType.some((entry) => typeof entry === "string" && entry !== "null"))
  ) {
    normalized.type = inferOllamaSchemaType(normalized) ?? (isRoot ? "object" : "string");
  }
  // Keep the root fallback, but do not turn nested implicit open objects into
  // empty property maps: Ollama then generates empty arguments.
  const isFreeFormObject =
    (normalized.additionalProperties !== false &&
      (!isRoot || "additionalProperties" in normalized)) ||
    isRecord(normalized.patternProperties);
  if (normalized.type === "object" && !isRecord(normalized.properties) && !isFreeFormObject) {
    normalized.properties = {};
  }
  return normalized;
}
