import { stripUnsupportedSchemaKeywords } from "../plugin-sdk/provider-tools.js";
import { resolveUnsupportedToolSchemaKeywords } from "../plugins/provider-model-compat.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { cleanSchemaForGemini } from "./schema/clean-for-gemini.js";
function extractEnumValues(schema) {
    if (!schema || typeof schema !== "object") {
        return undefined;
    }
    const record = schema;
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
function mergePropertySchemas(existing, incoming) {
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
        const merged = {};
        for (const source of [existing, incoming]) {
            if (!source || typeof source !== "object") {
                continue;
            }
            const record = source;
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
function hasTopLevelArrayKeyword(schemaRecord, key) {
    return Array.isArray(schemaRecord[key]);
}
function getFlattenableVariantKey(schemaRecord) {
    if (hasTopLevelArrayKeyword(schemaRecord, "anyOf")) {
        return "anyOf";
    }
    if (hasTopLevelArrayKeyword(schemaRecord, "oneOf")) {
        return "oneOf";
    }
    return null;
}
function getTopLevelConditionalKey(schemaRecord) {
    return (getFlattenableVariantKey(schemaRecord) ??
        (hasTopLevelArrayKeyword(schemaRecord, "allOf") ? "allOf" : null));
}
function hasTopLevelObjectSchema(schemaRecord, conditionalKey) {
    return "type" in schemaRecord && "properties" in schemaRecord && conditionalKey === null;
}
function isObjectLikeSchemaMissingType(schemaRecord, conditionalKey) {
    return (!("type" in schemaRecord) &&
        (typeof schemaRecord.properties === "object" || Array.isArray(schemaRecord.required)) &&
        conditionalKey === null);
}
function isTypedSchemaMissingProperties(schemaRecord, conditionalKey) {
    return "type" in schemaRecord && !("properties" in schemaRecord) && conditionalKey === null;
}
function isTrulyEmptySchema(schemaRecord) {
    return Object.keys(schemaRecord).length === 0;
}
export function normalizeToolParameterSchema(schema, options) {
    const schemaRecord = schema && typeof schema === "object" ? schema : undefined;
    if (!schemaRecord) {
        return schema;
    }
    // Provider quirks:
    // - Gemini rejects several JSON Schema keywords, so we scrub those.
    // - OpenAI rejects function tool schemas unless the *top-level* is `type: "object"`.
    //   (TypeBox root unions compile to `{ anyOf: [...] }` without `type`).
    // - Anthropic expects full JSON Schema draft 2020-12 compliance.
    // - xAI rejects validation-constraint keywords (minLength, maxLength, etc.) outright.
    //
    // Normalize once here so callers can always pass `tools` through unchanged.
    const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
    const isGeminiProvider = normalizedProvider.includes("google") || normalizedProvider.includes("gemini");
    const isAnthropicProvider = normalizedProvider.includes("anthropic");
    const unsupportedToolSchemaKeywords = resolveUnsupportedToolSchemaKeywords(options?.modelCompat);
    function applyProviderCleaning(s) {
        if (isGeminiProvider && !isAnthropicProvider) {
            return cleanSchemaForGemini(s);
        }
        if (unsupportedToolSchemaKeywords.size > 0) {
            return stripUnsupportedSchemaKeywords(s, unsupportedToolSchemaKeywords);
        }
        return s;
    }
    const conditionalKey = getTopLevelConditionalKey(schemaRecord);
    const flattenableVariantKey = getFlattenableVariantKey(schemaRecord);
    if (hasTopLevelObjectSchema(schemaRecord, conditionalKey)) {
        return applyProviderCleaning(schemaRecord);
    }
    if (isObjectLikeSchemaMissingType(schemaRecord, conditionalKey)) {
        return applyProviderCleaning({ ...schemaRecord, type: "object" });
    }
    if (isTypedSchemaMissingProperties(schemaRecord, conditionalKey)) {
        return applyProviderCleaning({ ...schemaRecord, properties: {} });
    }
    if (!flattenableVariantKey) {
        if (isTrulyEmptySchema(schemaRecord)) {
            // Handle the proven MCP no-parameter case: a truly empty schema object.
            return applyProviderCleaning({ type: "object", properties: {} });
        }
        if (conditionalKey === "allOf") {
            // Top-level `allOf` is not safely flattenable with the same heuristics we
            // use for unions. Keep it explicit rather than silently rewriting it.
            return applyProviderCleaning(schema);
        }
        return applyProviderCleaning(schema);
    }
    const variants = schemaRecord[flattenableVariantKey];
    const mergedProperties = {};
    const requiredCounts = new Map();
    let objectVariants = 0;
    for (const entry of variants) {
        if (!entry || typeof entry !== "object") {
            continue;
        }
        const props = entry.properties;
        if (!props || typeof props !== "object") {
            continue;
        }
        objectVariants += 1;
        for (const [key, value] of Object.entries(props)) {
            if (!(key in mergedProperties)) {
                mergedProperties[key] = value;
                continue;
            }
            mergedProperties[key] = mergePropertySchemas(mergedProperties[key], value);
        }
        const required = Array.isArray(entry.required)
            ? entry.required
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
    const mergedRequired = baseRequired && baseRequired.length > 0
        ? baseRequired
        : objectVariants > 0
            ? Array.from(requiredCounts.entries())
                .filter(([, count]) => count === objectVariants)
                .map(([key]) => key)
            : undefined;
    const nextSchema = { ...schemaRecord };
    const flattenedSchema = {
        type: "object",
        ...(typeof nextSchema.title === "string" ? { title: nextSchema.title } : {}),
        ...(typeof nextSchema.description === "string" ? { description: nextSchema.description } : {}),
        properties: Object.keys(mergedProperties).length > 0 ? mergedProperties : (schemaRecord.properties ?? {}),
        ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
        additionalProperties: "additionalProperties" in schemaRecord ? schemaRecord.additionalProperties : true,
    };
    // Flatten union schemas into a single object schema:
    // - Gemini doesn't allow top-level `type` together with `anyOf`.
    // - OpenAI rejects schemas without top-level `type: "object"`.
    // - Anthropic accepts proper JSON Schema with constraints.
    // Merging properties preserves useful enums like `action` while keeping schemas portable.
    return applyProviderCleaning(flattenedSchema);
}
