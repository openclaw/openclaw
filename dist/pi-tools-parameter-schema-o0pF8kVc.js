import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { s as resolveUnsupportedToolSchemaKeywords } from "./provider-model-compat-Dk5etUbu.js";
import { c as stripUnsupportedSchemaKeywords, u as cleanSchemaForGemini } from "./provider-tools-CWTapSmF.js";
//#region src/agents/pi-tools-parameter-schema.ts
function extractEnumValues(schema) {
	if (!schema || typeof schema !== "object") return;
	const record = schema;
	if (Array.isArray(record.enum)) return record.enum;
	if ("const" in record) return [record.const];
	const variants = Array.isArray(record.anyOf) ? record.anyOf : Array.isArray(record.oneOf) ? record.oneOf : null;
	if (variants) {
		const values = variants.flatMap((variant) => {
			return extractEnumValues(variant) ?? [];
		});
		return values.length > 0 ? values : void 0;
	}
}
function mergePropertySchemas(existing, incoming) {
	if (!existing) return incoming;
	if (!incoming) return existing;
	const existingEnum = extractEnumValues(existing);
	const incomingEnum = extractEnumValues(incoming);
	if (existingEnum || incomingEnum) {
		const values = Array.from(new Set([...existingEnum ?? [], ...incomingEnum ?? []]));
		const merged = {};
		for (const source of [existing, incoming]) {
			if (!source || typeof source !== "object") continue;
			const record = source;
			for (const key of [
				"title",
				"description",
				"default"
			]) if (!(key in merged) && key in record) merged[key] = record[key];
		}
		const types = new Set(values.map((value) => typeof value));
		if (types.size === 1) merged.type = Array.from(types)[0];
		merged.enum = values;
		return merged;
	}
	return existing;
}
function isSchemaRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function hasTopLevelArrayKeyword(schemaRecord, key) {
	return Array.isArray(schemaRecord[key]);
}
function getFlattenableVariantKey(schemaRecord) {
	if (hasTopLevelArrayKeyword(schemaRecord, "anyOf")) return "anyOf";
	if (hasTopLevelArrayKeyword(schemaRecord, "oneOf")) return "oneOf";
	return null;
}
function getTopLevelConditionalKey(schemaRecord) {
	return getFlattenableVariantKey(schemaRecord) ?? (hasTopLevelArrayKeyword(schemaRecord, "allOf") ? "allOf" : null);
}
function hasTopLevelObjectSchema(schemaRecord, conditionalKey) {
	return schemaRecord.type === "object" && isSchemaRecord(schemaRecord.properties) && conditionalKey === null;
}
function isObjectLikeSchemaMissingType(schemaRecord, conditionalKey) {
	return !("type" in schemaRecord) && (isSchemaRecord(schemaRecord.properties) || Array.isArray(schemaRecord.required)) && conditionalKey === null;
}
function isTypedObjectSchemaMissingValidProperties(schemaRecord, conditionalKey) {
	return schemaRecord.type === "object" && !isSchemaRecord(schemaRecord.properties) && conditionalKey === null;
}
function isTrulyEmptySchema(schemaRecord) {
	return Object.keys(schemaRecord).length === 0;
}
function normalizeArraySchemasMissingItems(schema) {
	if (!isSchemaRecord(schema)) return schema;
	let changed = false;
	const nextSchema = { ...schema };
	if (nextSchema.type === "array" && nextSchema.items === void 0) {
		nextSchema.items = {};
		changed = true;
	}
	const normalizeSchemaValue = (key) => {
		if (!(key in nextSchema)) return;
		const value = nextSchema[key];
		if (Array.isArray(value)) {
			const normalized = value.map(normalizeArraySchemasMissingItems);
			if (normalized.some((entry, index) => entry !== value[index])) {
				nextSchema[key] = normalized;
				changed = true;
			}
			return;
		}
		const normalized = normalizeArraySchemasMissingItems(value);
		if (normalized !== value) {
			nextSchema[key] = normalized;
			changed = true;
		}
	};
	for (const key of [
		"items",
		"contains",
		"additionalProperties",
		"propertyNames",
		"not",
		"if",
		"then",
		"else"
	]) normalizeSchemaValue(key);
	for (const key of [
		"anyOf",
		"oneOf",
		"allOf",
		"prefixItems"
	]) normalizeSchemaValue(key);
	for (const key of [
		"properties",
		"patternProperties",
		"dependentSchemas",
		"$defs",
		"definitions"
	]) {
		const value = nextSchema[key];
		if (!isSchemaRecord(value)) continue;
		let entriesChanged = false;
		const normalizedEntries = Object.entries(value).map(([entryKey, entryValue]) => {
			const normalizedEntryValue = normalizeArraySchemasMissingItems(entryValue);
			if (normalizedEntryValue !== entryValue) entriesChanged = true;
			return [entryKey, normalizedEntryValue];
		});
		if (entriesChanged) {
			nextSchema[key] = Object.fromEntries(normalizedEntries);
			changed = true;
		}
	}
	return changed ? nextSchema : schema;
}
function normalizeToolParameterSchema(schema, options) {
	const schemaRecord = schema && typeof schema === "object" ? schema : void 0;
	if (!schemaRecord) return schema;
	const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
	const isGeminiProvider = normalizedProvider.includes("google") || normalizedProvider.includes("gemini");
	const isAnthropicProvider = normalizedProvider.includes("anthropic");
	const unsupportedToolSchemaKeywords = resolveUnsupportedToolSchemaKeywords(options?.modelCompat);
	function applyProviderCleaning(s) {
		const normalizedSchema = normalizeArraySchemasMissingItems(s);
		if (isGeminiProvider && !isAnthropicProvider) return cleanSchemaForGemini(normalizedSchema);
		if (unsupportedToolSchemaKeywords.size > 0) return stripUnsupportedSchemaKeywords(normalizedSchema, unsupportedToolSchemaKeywords);
		return normalizedSchema;
	}
	const conditionalKey = getTopLevelConditionalKey(schemaRecord);
	const flattenableVariantKey = getFlattenableVariantKey(schemaRecord);
	if (hasTopLevelObjectSchema(schemaRecord, conditionalKey)) return applyProviderCleaning(schemaRecord);
	if (isObjectLikeSchemaMissingType(schemaRecord, conditionalKey)) return applyProviderCleaning({
		...schemaRecord,
		type: "object",
		properties: isSchemaRecord(schemaRecord.properties) ? schemaRecord.properties : {}
	});
	if (isTypedObjectSchemaMissingValidProperties(schemaRecord, conditionalKey)) return applyProviderCleaning({
		...schemaRecord,
		properties: {}
	});
	if (!flattenableVariantKey) {
		if (isTrulyEmptySchema(schemaRecord)) return applyProviderCleaning({
			type: "object",
			properties: {}
		});
		if (conditionalKey === "allOf") return applyProviderCleaning(schema);
		return applyProviderCleaning(schema);
	}
	const variants = schemaRecord[flattenableVariantKey];
	const mergedProperties = {};
	const requiredCounts = /* @__PURE__ */ new Map();
	let objectVariants = 0;
	for (const entry of variants) {
		if (!entry || typeof entry !== "object") continue;
		const props = entry.properties;
		if (!props || typeof props !== "object") continue;
		objectVariants += 1;
		for (const [key, value] of Object.entries(props)) {
			if (!(key in mergedProperties)) {
				mergedProperties[key] = value;
				continue;
			}
			mergedProperties[key] = mergePropertySchemas(mergedProperties[key], value);
		}
		const required = Array.isArray(entry.required) ? entry.required : [];
		for (const key of required) {
			if (typeof key !== "string") continue;
			requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1);
		}
	}
	const baseRequired = Array.isArray(schemaRecord.required) ? schemaRecord.required.filter((key) => typeof key === "string") : void 0;
	const mergedRequired = baseRequired && baseRequired.length > 0 ? baseRequired : objectVariants > 0 ? Array.from(requiredCounts.entries()).filter(([, count]) => count === objectVariants).map(([key]) => key) : void 0;
	const nextSchema = { ...schemaRecord };
	return applyProviderCleaning({
		type: "object",
		...typeof nextSchema.title === "string" ? { title: nextSchema.title } : {},
		...typeof nextSchema.description === "string" ? { description: nextSchema.description } : {},
		properties: Object.keys(mergedProperties).length > 0 ? mergedProperties : schemaRecord.properties ?? {},
		...mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {},
		additionalProperties: "additionalProperties" in schemaRecord ? schemaRecord.additionalProperties : true
	});
}
//#endregion
export { normalizeToolParameterSchema as t };
