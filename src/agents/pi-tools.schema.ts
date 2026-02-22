import type { AnyAgentTool } from "./pi-tools.types.js";
import { cleanSchemaForGemini } from "./schema/clean-for-gemini.js";

/**
 * Recursively strip `patternProperties` from a JSON Schema.
 *
 * TypeBox's `Type.Record(Type.String(), ...)` compiles to a schema with
 * `patternProperties` – a JSON Schema keyword that most OpenAI-compatible
 * providers (including RouteLLM) do not recognise and will reject with HTTP 400.
 * Anthropic's API handles it fine, so we only strip for non-Anthropic providers.
 * Gemini schemas go through `cleanSchemaForGemini` which already covers this.
 */
function stripPatternProperties(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(stripPatternProperties);
  }
  const obj = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "patternProperties") {
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          stripPatternProperties(v),
        ]),
      );
    } else if (
      (key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf") &&
      Array.isArray(value)
    ) {
      result[key] = value.map(stripPatternProperties);
    } else if (key === "items" && value && typeof value === "object") {
      result[key] = stripPatternProperties(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) {
    return record.enum;
  }
  if ("const" in record) {
    return [record.const];
  }
  const variants = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : null;
  if (variants) {
    const values = variants.flatMap((variant) => {
      const extracted = extractEnumValues(variant);
      return extracted ?? [];
    });
    return values.length > 0 ? values : undefined;
  }
  return undefined;
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }

  const existingEnum = extractEnumValues(existing);
  const incomingEnum = extractEnumValues(incoming);
  if (existingEnum || incomingEnum) {
    const values = Array.from(new Set([...(existingEnum ?? []), ...(incomingEnum ?? [])]));
    const merged: Record<string, unknown> = {};
    for (const source of [existing, incoming]) {
      if (!source || typeof source !== "object") {
        continue;
      }
      const record = source as Record<string, unknown>;
      for (const key of ["title", "description", "default"]) {
        if (!(key in merged) && key in record) {
          merged[key] = record[key];
        }
      }
    }
    const types = new Set(values.map((value) => typeof value));
    if (types.size === 1) {
      merged.type = Array.from(types)[0];
    }
    merged.enum = values;
    return merged;
  }

  return existing;
}

export function normalizeToolParameters(
  tool: AnyAgentTool,
  options?: { modelProvider?: string },
): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;
  if (!schema) {
    return tool;
  }

  // Provider quirks:
  // - Gemini rejects several JSON Schema keywords, so we scrub those.
  // - OpenAI rejects function tool schemas unless the *top-level* is `type: "object"`.
  //   (TypeBox root unions compile to `{ anyOf: [...] }` without `type`).
  // - Anthropic (google-antigravity) expects full JSON Schema draft 2020-12 compliance.
  // - Most OpenAI-compatible providers (e.g. RouteLLM) reject `patternProperties`,
  //   which TypeBox emits for `Type.Record(Type.String(), ...)` schemas.
  //
  // Normalize once here so callers can always pass `tools` through unchanged.

  const isGeminiProvider =
    options?.modelProvider?.toLowerCase().includes("google") ||
    options?.modelProvider?.toLowerCase().includes("gemini");
  const isAnthropicProvider =
    options?.modelProvider?.toLowerCase().includes("anthropic") ||
    options?.modelProvider?.toLowerCase().includes("google-antigravity");

  // If schema already has type + properties (no top-level anyOf to merge),
  // clean it for Gemini compatibility (but only if using Gemini, not Anthropic)
  if ("type" in schema && "properties" in schema && !Array.isArray(schema.anyOf)) {
    const cleaned =
      isGeminiProvider && !isAnthropicProvider
        ? cleanSchemaForGemini(schema)
        : isAnthropicProvider
          ? schema
          : stripPatternProperties(schema);
    return { ...tool, parameters: cleaned };
  }

  // Some tool schemas (esp. unions) may omit `type` at the top-level. If we see
  // object-ish fields, force `type: "object"` so OpenAI accepts the schema.
  if (
    !("type" in schema) &&
    (typeof schema.properties === "object" || Array.isArray(schema.required)) &&
    !Array.isArray(schema.anyOf) &&
    !Array.isArray(schema.oneOf)
  ) {
    const schemaWithType = { ...schema, type: "object" };
    const cleaned =
      isGeminiProvider && !isAnthropicProvider
        ? cleanSchemaForGemini(schemaWithType)
        : isAnthropicProvider
          ? schemaWithType
          : stripPatternProperties(schemaWithType);
    return { ...tool, parameters: cleaned };
  }

  const variantKey = Array.isArray(schema.anyOf)
    ? "anyOf"
    : Array.isArray(schema.oneOf)
      ? "oneOf"
      : null;
  if (!variantKey) {
    return tool;
  }
  const variants = schema[variantKey] as unknown[];
  const mergedProperties: Record<string, unknown> = {};
  const requiredCounts = new Map<string, number>();
  let objectVariants = 0;

  for (const entry of variants) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const props = (entry as { properties?: unknown }).properties;
    if (!props || typeof props !== "object") {
      continue;
    }
    objectVariants += 1;
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      if (!(key in mergedProperties)) {
        mergedProperties[key] = value;
        continue;
      }
      mergedProperties[key] = mergePropertySchemas(mergedProperties[key], value);
    }
    const required = Array.isArray((entry as { required?: unknown }).required)
      ? (entry as { required: unknown[] }).required
      : [];
    for (const key of required) {
      if (typeof key !== "string") {
        continue;
      }
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
    }
  }

  const baseRequired = Array.isArray(schema.required)
    ? schema.required.filter((key) => typeof key === "string")
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : objectVariants > 0
        ? Array.from(requiredCounts.entries())
            .filter(([, count]) => count === objectVariants)
            .map(([key]) => key)
        : undefined;

  const nextSchema: Record<string, unknown> = { ...schema };
  const flattenedSchema = {
    type: "object",
    ...(typeof nextSchema.title === "string" ? { title: nextSchema.title } : {}),
    ...(typeof nextSchema.description === "string" ? { description: nextSchema.description } : {}),
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : (schema.properties ?? {}),
    ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
    additionalProperties: "additionalProperties" in schema ? schema.additionalProperties : true,
  };

  // Flatten union schemas into a single object schema:
  // - Gemini doesn't allow top-level `type` together with `anyOf`.
  // - OpenAI rejects schemas without top-level `type: "object"`.
  // - Anthropic accepts proper JSON Schema with constraints.
  // Merging properties preserves useful enums like `action` while keeping schemas portable.
  const flattenedCleaned =
    isGeminiProvider && !isAnthropicProvider
      ? cleanSchemaForGemini(flattenedSchema)
      : isAnthropicProvider
        ? flattenedSchema
        : stripPatternProperties(flattenedSchema);
  return { ...tool, parameters: flattenedCleaned };
}

/**
 * @deprecated Use normalizeToolParameters with modelProvider instead.
 * This function should only be used for Gemini providers.
 */
export function cleanToolSchemaForGemini(schema: Record<string, unknown>): unknown {
  return cleanSchemaForGemini(schema);
}
