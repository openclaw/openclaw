import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { c as shouldOmitEmptyArrayItems, s as resolveUnsupportedToolSchemaKeywords } from "./provider-model-compat-CmPOKTzc.js";
import { d as stripUnsupportedSchemaKeywords, p as cleanSchemaForGemini } from "./provider-tools-D8Ja_oUH.js";
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
function setOwnSchemaProperty(target, key, value) {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true
	});
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
function schemaAllowsArrayType(schema) {
	const type = schema.type;
	return type === "array" || Array.isArray(type) && type.includes("array");
}
const ARRAY_ITEMS_SCHEMA_OBJECT_KEYS = new Set([
	"additionalProperties",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then"
]);
const ARRAY_ITEMS_SCHEMA_ARRAY_KEYS = new Set([
	"allOf",
	"anyOf",
	"oneOf",
	"prefixItems"
]);
const ARRAY_ITEMS_SCHEMA_MAP_KEYS = new Set([
	"$defs",
	"definitions",
	"dependentSchemas",
	"patternProperties",
	"properties"
]);
function stripEmptyArrayItemsFromArraySchemas(schema) {
	if (Array.isArray(schema)) {
		let changed = false;
		const entries = schema.map((entry) => {
			const next = stripEmptyArrayItemsFromArraySchemas(entry);
			changed ||= next !== entry;
			return next;
		});
		return changed ? entries : schema;
	}
	if (!isSchemaRecord(schema)) return schema;
	let changed = false;
	const entries = Object.entries(schema).flatMap(([key, value]) => {
		if (key === "items" && schemaAllowsArrayType(schema) && isSchemaRecord(value) && isTrulyEmptySchema(value)) {
			changed = true;
			return [];
		}
		if (ARRAY_ITEMS_SCHEMA_OBJECT_KEYS.has(key)) {
			const next = stripEmptyArrayItemsFromArraySchemas(value);
			changed ||= next !== value;
			return [[key, next]];
		}
		if (ARRAY_ITEMS_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
			const next = stripEmptyArrayItemsFromArraySchemas(value);
			changed ||= next !== value;
			return [[key, next]];
		}
		if (ARRAY_ITEMS_SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
			let mapChanged = false;
			const next = Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => {
				const entryNext = stripEmptyArrayItemsFromArraySchemas(entryValue);
				mapChanged ||= entryNext !== entryValue;
				return [entryKey, entryNext];
			}));
			changed ||= mapChanged;
			return [[key, mapChanged ? next : value]];
		}
		return [[key, value]];
	});
	return changed ? Object.fromEntries(entries) : schema;
}
function copySchemaMeta(from, to) {
	for (const key of [
		"title",
		"description",
		"default"
	]) if (key in from && from[key] !== void 0) to[key] = from[key];
}
function extendSchemaDefs(defs, schema) {
	const defsEntry = schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs) ? schema.$defs : void 0;
	const legacyDefsEntry = schema.definitions && typeof schema.definitions === "object" && !Array.isArray(schema.definitions) ? schema.definitions : void 0;
	if (!defsEntry && !legacyDefsEntry) return defs;
	const next = defs ? {
		$defs: new Map(defs.$defs),
		definitions: new Map(defs.definitions)
	} : {
		$defs: /* @__PURE__ */ new Map(),
		definitions: /* @__PURE__ */ new Map()
	};
	if (defsEntry) for (const [key, value] of Object.entries(defsEntry)) next.$defs.set(key, value);
	if (legacyDefsEntry) for (const [key, value] of Object.entries(legacyDefsEntry)) next.definitions.set(key, value);
	return next;
}
function decodeJsonPointerSegment(segment) {
	return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}
function resolveJsonPointerPath(value, segments) {
	let current = value;
	for (const segment of segments) {
		if (!current || typeof current !== "object") return;
		const key = decodeJsonPointerSegment(segment);
		if (Array.isArray(current)) {
			const index = Number(key);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return;
			current = current[index];
			continue;
		}
		const record = current;
		if (!Object.prototype.hasOwnProperty.call(record, key)) return;
		current = record[key];
	}
	return current;
}
function tryResolveLocalRef(ref, defs) {
	if (!defs) return;
	const match = ref.match(/^#\/(\$defs|definitions)\/([^/]+)(?:\/(.*))?$/);
	if (!match) return;
	const namespace = match[1] === "$defs" ? defs.$defs : defs.definitions;
	const name = decodeJsonPointerSegment(match[2] ?? "");
	const resolved = name ? namespace.get(name) : void 0;
	if (resolved === void 0) return;
	return resolveJsonPointerPath(resolved, match[3] ? match[3].split("/") : []);
}
function inlineLocalSchemaRefsWithDefs(schema, defs, refStack, state) {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map((entry) => inlineLocalSchemaRefsWithDefs(entry, defs, refStack, state));
	const obj = schema;
	const nextDefs = extendSchemaDefs(defs, obj);
	const refValue = typeof obj.$ref === "string" ? obj.$ref : void 0;
	if (refValue) {
		if (refStack?.has(refValue)) return {};
		const resolved = tryResolveLocalRef(refValue, nextDefs);
		if (resolved === void 0) {
			if (refValue.startsWith("#/")) state.unresolvedLocalRefs = true;
			return { ...obj };
		}
		const nextRefStack = refStack ? new Set(refStack) : /* @__PURE__ */ new Set();
		nextRefStack.add(refValue);
		const inlined = inlineLocalSchemaRefsWithDefs(resolved, nextDefs, nextRefStack, state);
		if (!inlined || typeof inlined !== "object" || Array.isArray(inlined)) return inlined;
		const result = { ...inlined };
		copySchemaMeta(obj, result);
		return result;
	}
	const result = {};
	for (const [key, value] of Object.entries(obj)) {
		if (key === "$defs" || key === "definitions") continue;
		setOwnSchemaProperty(result, key, inlineLocalSchemaRefsWithDefs(value, nextDefs, refStack, state));
	}
	if (state.unresolvedLocalRefs) {
		if ("$defs" in obj) result.$defs = obj.$defs;
		if ("definitions" in obj) result.definitions = obj.definitions;
	}
	return result;
}
function inlineLocalToolSchemaRefs(schema) {
	if (!schema || typeof schema !== "object") return schema;
	return inlineLocalSchemaRefsWithDefs(schema, extendSchemaDefs(void 0, schema), void 0, { unresolvedLocalRefs: false });
}
function normalizeToolParameterSchema(schema, options) {
	const inlinedSchema = inlineLocalToolSchemaRefs(schema);
	const schemaRecord = inlinedSchema && typeof inlinedSchema === "object" ? inlinedSchema : void 0;
	if (!schemaRecord) return inlinedSchema;
	const normalizedProvider = normalizeLowercaseStringOrEmpty(options?.modelProvider);
	const isGeminiProvider = normalizedProvider.includes("google") || normalizedProvider.includes("gemini");
	const isAnthropicProvider = normalizedProvider.includes("anthropic");
	const unsupportedToolSchemaKeywords = resolveUnsupportedToolSchemaKeywords(options?.modelCompat);
	const omitEmptyArrayItems = shouldOmitEmptyArrayItems(options?.modelCompat);
	function applyProviderCleaning(s) {
		const normalizedSchema = normalizeArraySchemasMissingItems(s);
		const arrayItemsCompatibleSchema = omitEmptyArrayItems ? stripEmptyArrayItemsFromArraySchemas(normalizedSchema) : normalizedSchema;
		if (isGeminiProvider && !isAnthropicProvider) return cleanSchemaForGemini(arrayItemsCompatibleSchema);
		if (unsupportedToolSchemaKeywords.size > 0) return stripUnsupportedSchemaKeywords(arrayItemsCompatibleSchema, unsupportedToolSchemaKeywords);
		return arrayItemsCompatibleSchema;
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
		if (conditionalKey === "allOf") return applyProviderCleaning(inlinedSchema);
		return applyProviderCleaning(inlinedSchema);
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
