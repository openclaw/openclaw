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
import { normalizeToolSchema } from "./tool-schema-normalization.js";
import {
  setOwnSchemaProperty,
  inlineLocalToolSchemaRefs,
  canPreserveRootSchemaRefs,
  SCHEMA_MAP_KEYS,
  SCHEMA_OBJECT_KEYS,
  SCHEMA_ARRAY_KEYS,
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

function isGeminiModelId(modelId: string): boolean {
  return /(?:^|[/:])gemini(?:$|[-/:.])/.test(modelId);
}

function extractEnumValues(schema: unknown, requireAllVariants = false): unknown[] | undefined {
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
    let complete = true;
    const values = variants.flatMap((variant) => {
      const extracted = extractEnumValues(variant, requireAllVariants);
      complete &&= extracted !== undefined;
      return extracted ?? [];
    });
    return (!requireAllVariants || complete) && values.length > 0 ? values : undefined;
  }
  return undefined;
}

function isUnconstrainedStringSchema(schema: unknown): schema is Record<string, unknown> {
  return (
    isSchemaRecord(schema) &&
    schema.type === "string" &&
    Object.keys(schema).every((key) =>
      ["type", "title", "description", "default", "examples"].includes(key),
    )
  );
}

function mergePropertySchemas(
  existing: unknown,
  incoming: unknown,
  allowUnconstrainedString: boolean,
): unknown {
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
    // The caller checks every alternative before allowing a free string to
    // absorb presets, so a later non-string branch cannot discard those presets.
    if (allowUnconstrainedString) {
      if (
        existingEnum?.every((value) => typeof value === "string") &&
        isUnconstrainedStringSchema(incoming)
      ) {
        return { ...incoming, ...merged };
      }
      if (
        incomingEnum?.every((value) => typeof value === "string") &&
        isUnconstrainedStringSchema(existing)
      ) {
        return { ...existing, ...merged };
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

/** Return a provider-compatible JSON schema for a model-facing tool. */
export function normalizeToolParameterSchema(
  schema: unknown,
  options?: ToolParameterSchemaOptions,
): TSchema {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(options?.modelId);
  const normalizedToolSchemaProfile = normalizeLowercaseStringOrEmpty(
    options?.modelCompat?.toolSchemaProfile,
  );
  const unsupportedToolSchemaKeywords = resolveUnsupportedToolSchemaKeywords(options?.modelCompat);
  const omitEmptyArrayItems = shouldOmitEmptyArrayItems(options?.modelCompat);
  const source = schema && typeof schema === "object" ? schema : undefined;
  const cacheKey = source
    ? JSON.stringify([
        normalizedProvider,
        normalizedModelId,
        normalizedToolSchemaProfile,
        [...unsupportedToolSchemaKeywords].toSorted(),
        omitEmptyArrayItems,
      ])
    : "";
  if (source) {
    const cached = toolParameterSchemaCache.get(source, cacheKey);
    if (cached) {
      return cached;
    }
  }
  const rememberResult = (normalized: TSchema): TSchema =>
    source ? toolParameterSchemaCache.remember(source, cacheKey, normalized) : normalized;
  const isGeminiProvider =
    normalizedProvider.includes("google") ||
    normalizedProvider.includes("gemini") ||
    isGeminiModelId(normalizedModelId) ||
    normalizedToolSchemaProfile === "gemini";
  const isAnthropicProvider = normalizedProvider.includes("anthropic");
  const isLlamacppGbnfProfile = normalizedToolSchemaProfile === "llamacpp";
  const preserveRefs =
    normalizedProvider === "openai" &&
    !isGeminiProvider &&
    !isLlamacppGbnfProfile &&
    !["$ref", "$defs", "definitions"].some((key) => unsupportedToolSchemaKeywords.has(key)) &&
    canPreserveRootSchemaRefs(schema);
  const inlinedSchema = normalizeToolSchema(
    preserveRefs ? schema : inlineLocalToolSchemaRefs(schema),
    "openapi",
  );
  const schemaRecord =
    inlinedSchema && typeof inlinedSchema === "object"
      ? (inlinedSchema as Record<string, unknown>)
      : undefined;
  if (!schemaRecord) {
    return rememberResult(inlinedSchema as TSchema);
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
    return rememberResult(arrayItemsCompatibleSchema as TSchema);
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
  const rootProperties = isSchemaRecord(schemaRecord.properties) ? schemaRecord.properties : {};
  const mergedProperties: Record<string, unknown> = { ...rootProperties };
  const propertyAlternatives = new Map<string, unknown[]>();
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
      const alternatives = propertyAlternatives.get(key);
      if (alternatives) {
        alternatives.push(value);
      } else {
        propertyAlternatives.set(key, [value]);
      }
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

  for (const [key, alternatives] of propertyAlternatives) {
    // Root properties constrain every branch and retain the existing merge policy.
    const allowUnconstrainedString =
      !Object.hasOwn(rootProperties, key) &&
      alternatives.every(
        (alternative) =>
          isUnconstrainedStringSchema(alternative) ||
          extractEnumValues(alternative, true)?.every((value) => typeof value === "string") ===
            true,
      );
    let merged = Object.hasOwn(mergedProperties, key) ? mergedProperties[key] : undefined;
    for (const alternative of alternatives) {
      merged = mergePropertySchemas(merged, alternative, allowUnconstrainedString);
    }
    setOwnSchemaProperty(mergedProperties, key, merged);
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
