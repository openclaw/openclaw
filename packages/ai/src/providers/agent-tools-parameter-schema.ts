/**
 * Normalizes model-facing tool parameter schemas across provider quirks.
 * Handles local JSON Schema refs, OpenAPI nullable syntax, top-level unions,
 * and provider-specific unsupported keyword stripping.
 */
import { isRecord as isSchemaRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueValues,
} from "@openclaw/normalization-core/string-normalization";
import type { TSchema } from "typebox";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";
import { cleanSchemaForLlamacppGbnf } from "./clean-for-llamacpp-gbnf.js";
import { stripUnsupportedSchemaKeywords } from "./schema-keyword-strip.js";
import { createToolSchemaNormalizationCache } from "./tool-schema-normalization-cache.js";
import {
  setOwnSchemaProperty,
  copySchemaMeta,
  inlineLocalToolSchemaRefs,
  canPreserveRootSchemaRefs,
  SCHEMA_MAP_KEYS,
  SCHEMA_OBJECT_KEYS,
  SCHEMA_ARRAY_KEYS,
  SCHEMA_LITERAL_KEYS,
} from "./tool-schema-refs.js";

/**
 * Narrow structural view of the host's model compat config. packages/ai must stay
 * config-agnostic, so only tool-schema-relevant fields are modeled here; the host's
 * ModelCompatConfig remains structurally assignable.
 */
export type ToolSchemaModelCompat = {
  toolSchemaProfile?: string;
  unsupportedToolSchemaKeywords?: string[];
  omitEmptyArrayItems?: boolean;
};

/** Extracts the compat record whether callers pass a model (`{ compat }`) or the compat itself. */
export function extractToolSchemaModelCompat(
  modelOrCompat: { compat?: unknown } | ToolSchemaModelCompat | undefined,
): ToolSchemaModelCompat | undefined {
  if (!modelOrCompat || typeof modelOrCompat !== "object") {
    return undefined;
  }
  if ("compat" in modelOrCompat) {
    const compat = (modelOrCompat as { compat?: unknown }).compat;
    return compat && typeof compat === "object" ? (compat as ToolSchemaModelCompat) : undefined;
  }
  return modelOrCompat as ToolSchemaModelCompat;
}

/** JSON Schema keywords this model/provider rejects in tool schemas. */
export function resolveUnsupportedToolSchemaKeywords(
  modelOrCompat: { compat?: unknown } | ToolSchemaModelCompat | undefined,
): ReadonlySet<string> {
  const keywords = extractToolSchemaModelCompat(modelOrCompat)?.unsupportedToolSchemaKeywords ?? [];
  return new Set(
    normalizeStringEntries(
      keywords.filter((keyword): keyword is string => typeof keyword === "string"),
    ),
  );
}

/** Whether empty `items: {}` on array schemas must be omitted for this model/provider. */
export function shouldOmitEmptyArrayItems(
  modelOrCompat: { compat?: unknown } | ToolSchemaModelCompat | undefined,
): boolean {
  return extractToolSchemaModelCompat(modelOrCompat)?.omitEmptyArrayItems === true;
}

export type ToolParameterSchemaOptions = {
  modelProvider?: string;
  modelId?: string;
  modelCompat?: ToolSchemaModelCompat;
};

const MAX_TOOL_PARAMETER_SCHEMA_CACHE_ENTRIES_PER_SCHEMA = 8;
const toolParameterSchemaCache = createToolSchemaNormalizationCache<TSchema>(
  MAX_TOOL_PARAMETER_SCHEMA_CACHE_ENTRIES_PER_SCHEMA,
);

function resolveToolParameterSchemaCacheKey(
  options: ToolParameterSchemaOptions | undefined,
): string {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(options?.modelId);
  const toolSchemaProfile = normalizeLowercaseStringOrEmpty(
    options?.modelCompat?.toolSchemaProfile,
  );
  const unsupportedKeywords = Array.from(
    resolveUnsupportedToolSchemaKeywords(options?.modelCompat),
  ).toSorted();
  const omitEmptyArrayItems = shouldOmitEmptyArrayItems(options?.modelCompat);
  return JSON.stringify([
    normalizedProvider,
    normalizedModelId,
    toolSchemaProfile,
    unsupportedKeywords,
    omitEmptyArrayItems,
  ]);
}

function isGeminiModelId(modelId: string): boolean {
  return /(?:^|[/:])gemini(?:$|[-/:.])/.test(modelId);
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
    const values = uniqueValues([...(existingEnum ?? []), ...(incomingEnum ?? [])]);
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

type ArrayItemsMode = "add" | "omit" | "normalize";

function normalizeArraySchemaItems(schema: unknown, mode: ArrayItemsMode): unknown {
  if (Array.isArray(schema)) {
    // Only omission descends through a malformed array used as a schema node.
    // Addition visits direct tuple/composition entries through normalizeValue below.
    if (mode === "add") {
      return schema;
    }
    const entries = schema.map((entry) => normalizeArraySchemaItems(entry, "omit"));
    return entries.some((entry, index) => entry !== schema[index]) ? entries : schema;
  }
  if (!isSchemaRecord(schema)) {
    return schema;
  }

  const missingItems = mode !== "omit" && schema.type === "array" && schema.items === undefined;
  let changed = missingItems;
  const normalized: Record<string, unknown> = { ...schema };
  if (missingItems) {
    if (mode === "add") {
      normalized.items = {};
    } else {
      // The former add-then-omit flow also removed an explicitly undefined items key.
      delete normalized.items;
    }
  }
  const allowsArray =
    schema.type === "array" || (Array.isArray(schema.type) && schema.type.includes("array"));
  const normalizeValue = (value: unknown, valueMode: ArrayItemsMode): unknown => {
    if (!Array.isArray(value)) {
      return normalizeArraySchemaItems(value, valueMode);
    }
    const entries = value.map((entry) => normalizeArraySchemaItems(entry, valueMode));
    return entries.some((entry, index) => entry !== value[index]) ? entries : value;
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (
      mode !== "add" &&
      key === "items" &&
      allowsArray &&
      isSchemaRecord(value) &&
      Object.keys(value).length === 0
    ) {
      delete normalized.items;
      changed = true;
      continue;
    }
    let next = value;
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      const entries = Object.entries(value);
      for (const entry of entries) {
        entry[1] = normalizeArraySchemaItems(entry[1], mode);
      }
      if (entries.some(([entryKey, entry]) => entry !== value[entryKey])) {
        next = Object.fromEntries(entries);
      }
    } else if (SCHEMA_OBJECT_KEYS.has(key) || SCHEMA_ARRAY_KEYS.has(key)) {
      // Addition historically accepts a schema object in a composition slot;
      // omission only traverses composition arrays. Keep that malformed-input boundary.
      const valueMode = SCHEMA_OBJECT_KEYS.has(key) || Array.isArray(value) ? mode : "add";
      if (valueMode === mode || mode !== "omit") {
        next = normalizeValue(value, valueMode);
      }
    }
    if (next !== value) {
      setOwnSchemaProperty(normalized, key, next);
      changed = true;
    }
  }
  return changed ? normalized : schema;
}

const OPENAPI_SCHEMA_ANNOTATION_KEYS = new Set([
  "discriminator",
  "externalDocs",
  "readOnly",
  "writeOnly",
  "xml",
  "example",
]);

function appendNullSchemaType(type: unknown): unknown {
  if (type === "null") {
    return type;
  }
  if (typeof type === "string") {
    return [type, "null"];
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? type : [...type, "null"];
  }
  return type;
}

function isNullSchemaLike(schema: unknown): boolean {
  if (!isSchemaRecord(schema)) {
    return false;
  }
  if (schema.type === "null") {
    return true;
  }
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }
  if ("const" in schema && schema.const === null) {
    return true;
  }
  return Array.isArray(schema.enum) && schema.enum.includes(null);
}

function hasOpenApiComposition(schema: Record<string, unknown>): boolean {
  return ["allOf", "anyOf", "oneOf"].some((key) => Array.isArray(schema[key]));
}

function schemaCompositionAlreadyAllowsNull(schema: Record<string, unknown>): boolean {
  return (
    (Array.isArray(schema.anyOf) && schema.anyOf.some(isNullSchemaLike)) ||
    (Array.isArray(schema.oneOf) && schema.oneOf.some(isNullSchemaLike))
  );
}

function wrapNullableComposedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schemaCompositionAlreadyAllowsNull(schema)) {
    return schema;
  }
  const wrapped: Record<string, unknown> = {
    anyOf: [schema, { type: "null" }],
  };
  copySchemaMeta(schema, wrapped);
  return wrapped;
}

function normalizeOpenApiSchemaKeywords(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeOpenApiSchemaKeywords(entry);
      changed ||= next !== entry;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!isSchemaRecord(schema)) {
    return schema;
  }

  let changed = false;
  const nullable = schema.nullable === true;
  const entries = Object.entries(schema);
  let normalized: Record<string, unknown> | undefined;
  for (const [key, value] of entries) {
    if (key === "nullable" || OPENAPI_SCHEMA_ANNOTATION_KEYS.has(key)) {
      normalized ??= Object.fromEntries(entries);
      delete normalized[key];
      changed = true;
      continue;
    }
    if (SCHEMA_LITERAL_KEYS.has(key) || key === "components") {
      continue;
    }
    let next = value;
    if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
      let mapChanged = false;
      const mapEntries = Object.entries(value);
      for (const entry of mapEntries) {
        const nextEntry = normalizeOpenApiSchemaKeywords(entry[1]);
        mapChanged ||= nextEntry !== entry[1];
        entry[1] = nextEntry;
      }
      next = mapChanged ? Object.fromEntries(mapEntries) : value;
    } else if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
      next = normalizeOpenApiSchemaKeywords(value);
    } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
      const nextEntries = value.map(normalizeOpenApiSchemaKeywords);
      // A changed sibling also exposes these composition-array copies.
      (normalized ??= Object.fromEntries(entries))[key] = nextEntries;
      changed ||= nextEntries.some((entry, index) => entry !== value[index]);
      continue;
    }
    if (next !== value) {
      (normalized ??= Object.fromEntries(entries))[key] = next;
      changed = true;
    }
  }

  if (nullable) {
    normalized ??= Object.fromEntries(entries);
    if (hasOpenApiComposition(normalized)) {
      return wrapNullableComposedSchema(normalized);
    }
    if ("type" in normalized) {
      const nextType = appendNullSchemaType(normalized.type);
      if (nextType !== normalized.type) {
        normalized.type = nextType;
      }
    }
    if (Array.isArray(normalized.enum) && !normalized.enum.includes(null)) {
      normalized.enum = [...normalized.enum, null];
    }
  }

  return changed || nullable ? (normalized ?? schema) : schema;
}

function normalizeToolParameterSchemaUncached(
  schema: unknown,
  options?: ToolParameterSchemaOptions,
): TSchema {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(options?.modelId);
  const normalizedToolSchemaProfile = normalizeLowercaseStringOrEmpty(
    options?.modelCompat?.toolSchemaProfile,
  );
  const isGeminiProvider =
    normalizedProvider.includes("google") ||
    normalizedProvider.includes("gemini") ||
    isGeminiModelId(normalizedModelId) ||
    normalizedToolSchemaProfile === "gemini";
  const isAnthropicProvider = normalizedProvider.includes("anthropic");
  const unsupportedToolSchemaKeywords = resolveUnsupportedToolSchemaKeywords(options?.modelCompat);
  const omitEmptyArrayItems = shouldOmitEmptyArrayItems(options?.modelCompat);
  const isLlamacppGbnfProfile = normalizedToolSchemaProfile === "llamacpp";
  const preserveRefs =
    normalizedProvider === "openai" &&
    !isGeminiProvider &&
    !isLlamacppGbnfProfile &&
    !["$ref", "$defs", "definitions"].some((key) => unsupportedToolSchemaKeywords.has(key)) &&
    canPreserveRootSchemaRefs(schema);
  const inlinedSchema = normalizeOpenApiSchemaKeywords(
    preserveRefs ? schema : inlineLocalToolSchemaRefs(schema),
  );
  const schemaRecord =
    inlinedSchema && typeof inlinedSchema === "object"
      ? (inlinedSchema as Record<string, unknown>)
      : undefined;
  if (!schemaRecord) {
    return inlinedSchema as TSchema;
  }

  function applyProviderCleaning(s: unknown): TSchema {
    let arrayItemsCompatibleSchema = normalizeArraySchemaItems(
      s,
      omitEmptyArrayItems ? "normalize" : "add",
    );
    if (isLlamacppGbnfProfile) {
      arrayItemsCompatibleSchema = cleanSchemaForLlamacppGbnf(arrayItemsCompatibleSchema);
    }
    if (isGeminiProvider && !isAnthropicProvider) {
      arrayItemsCompatibleSchema = cleanSchemaForGemini(arrayItemsCompatibleSchema);
    }
    if (unsupportedToolSchemaKeywords.size > 0) {
      arrayItemsCompatibleSchema = stripUnsupportedSchemaKeywords(
        arrayItemsCompatibleSchema,
        unsupportedToolSchemaKeywords,
      );
    }
    return arrayItemsCompatibleSchema as TSchema;
  }

  const flattenableVariantKey = Array.isArray(schemaRecord.anyOf)
    ? "anyOf"
    : Array.isArray(schemaRecord.oneOf)
      ? "oneOf"
      : undefined;
  if (!flattenableVariantKey && !Array.isArray(schemaRecord.allOf)) {
    const hasProperties = isSchemaRecord(schemaRecord.properties);
    if (schemaRecord.type === "object") {
      return applyProviderCleaning(
        hasProperties ? schemaRecord : { ...schemaRecord, properties: {} },
      );
    }
    if (!("type" in schemaRecord) && (hasProperties || Array.isArray(schemaRecord.required))) {
      return applyProviderCleaning({
        ...schemaRecord,
        type: "object",
        properties: hasProperties ? schemaRecord.properties : {},
      });
    }
  }

  if (!flattenableVariantKey) {
    // MCP's empty no-parameter schema needs an object root; preserve explicit allOf schemas.
    return applyProviderCleaning(
      Object.keys(schemaRecord).length === 0 ? { type: "object", properties: {} } : inlinedSchema,
    );
  }
  const variants = schemaRecord[flattenableVariantKey] as unknown[];
  // Root-required properties must survive branch merging when additionalProperties is false.
  const mergedProperties: Record<string, unknown> = isSchemaRecord(schemaRecord.properties)
    ? { ...schemaRecord.properties }
    : {};
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
      const existing = Object.hasOwn(mergedProperties, key) ? mergedProperties[key] : undefined;
      setOwnSchemaProperty(mergedProperties, key, mergePropertySchemas(existing, value));
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

  const baseRequired = Array.isArray(schemaRecord.required)
    ? schemaRecord.required.filter((key) => typeof key === "string")
    : undefined;
  const mergedRequired =
    baseRequired && baseRequired.length > 0
      ? baseRequired
      : objectVariants > 0
        ? Array.from(requiredCounts.entries())
            .filter(([, count]) => count === objectVariants)
            .map(([key]) => key)
        : undefined;

  const flattenedSchema = {
    type: "object",
    ...(typeof schemaRecord.title === "string" ? { title: schemaRecord.title } : {}),
    ...(typeof schemaRecord.description === "string"
      ? { description: schemaRecord.description }
      : {}),
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : (schemaRecord.properties ?? {}),
    ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
    additionalProperties:
      "additionalProperties" in schemaRecord ? schemaRecord.additionalProperties : true,
  };

  // Gemini and OpenAI require an object root; retain discriminator enums while flattening.
  return applyProviderCleaning(flattenedSchema);
}

/** Return a provider-compatible JSON schema for a model-facing tool. */
export function normalizeToolParameterSchema(
  schema: unknown,
  options?: ToolParameterSchemaOptions,
): TSchema {
  if (!schema || typeof schema !== "object") {
    return normalizeToolParameterSchemaUncached(schema, options);
  }
  const cacheKey = resolveToolParameterSchemaCacheKey(options);
  const cached = toolParameterSchemaCache.get(schema, cacheKey);
  if (cached) {
    return cached;
  }
  return toolParameterSchemaCache.remember(
    schema,
    cacheKey,
    normalizeToolParameterSchemaUncached(schema, options),
  );
}
