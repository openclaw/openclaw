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
function resolveLocalJsonPointer(rootDocument, ref) {
	if (!ref.startsWith("#/")) return;
	return resolveJsonPointerPath(rootDocument, ref.slice(2).split("/"));
}
const SCHEMA_MAP_KEYS = new Set([
	"$defs",
	"definitions",
	"dependentSchemas",
	"patternProperties",
	"properties"
]);
const SCHEMA_OBJECT_KEYS = new Set([
	"additionalProperties",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then"
]);
const SCHEMA_ARRAY_KEYS = new Set([
	"allOf",
	"anyOf",
	"items",
	"oneOf",
	"prefixItems"
]);
const SCHEMA_LITERAL_KEYS = new Set([
	"const",
	"default",
	"enum",
	"examples"
]);
function tryResolveLocalRef(ref, defs, rootDocument) {
	const match = ref.match(/^#\/(\$defs|definitions)\/([^/]+)(?:\/(.*))?$/);
	if (match && defs) {
		const namespace = match[1] === "$defs" ? defs.$defs : defs.definitions;
		const name = decodeJsonPointerSegment(match[2] ?? "");
		const resolved = name ? namespace.get(name) : void 0;
		if (resolved !== void 0) return resolveJsonPointerPath(resolved, match[3] ? match[3].split("/") : []);
	}
	return resolveLocalJsonPointer(rootDocument, ref);
}
function inlineLocalSchemaRefsWithDefs(schema, defs, refStack, state, rootDocument) {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map((entry) => inlineLocalSchemaRefsWithDefs(entry, defs, refStack, state, rootDocument));
	const obj = schema;
	const nextDefs = extendSchemaDefs(defs, obj);
	const refValue = typeof obj.$ref === "string" ? obj.$ref : void 0;
	if (refValue) {
		if (refStack?.has(refValue)) return {};
		const resolved = tryResolveLocalRef(refValue, nextDefs, rootDocument);
		if (resolved === void 0) {
			if (refValue.startsWith("#/")) state.unresolvedLocalRefs = true;
			return { ...obj };
		}
		const nextRefStack = refStack ? new Set(refStack) : /* @__PURE__ */ new Set();
		nextRefStack.add(refValue);
		const inlined = inlineLocalSchemaRefsWithDefs(resolved, nextDefs, nextRefStack, state, rootDocument);
		if (!inlined || typeof inlined !== "object" || Array.isArray(inlined)) return inlined;
		const result = { ...inlined };
		copySchemaMeta(obj, result);
		if (obj.nullable === true) result.nullable = true;
		return result;
	}
	const result = {};
	for (const [key, value] of Object.entries(obj)) {
		if (key === "$defs" || key === "definitions" || key === "components") continue;
		if (SCHEMA_LITERAL_KEYS.has(key)) {
			setOwnSchemaProperty(result, key, value);
			continue;
		}
		if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
			setOwnSchemaProperty(result, key, Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, inlineLocalSchemaRefsWithDefs(entryValue, nextDefs, refStack, state, rootDocument)])));
			continue;
		}
		if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
			setOwnSchemaProperty(result, key, inlineLocalSchemaRefsWithDefs(value, nextDefs, refStack, state, rootDocument));
			continue;
		}
		if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
			setOwnSchemaProperty(result, key, value.map((entry) => inlineLocalSchemaRefsWithDefs(entry, nextDefs, refStack, state, rootDocument)));
			continue;
		}
		setOwnSchemaProperty(result, key, value);
	}
	if (state.unresolvedLocalRefs) {
		if ("$defs" in obj) result.$defs = obj.$defs;
		if ("definitions" in obj) result.definitions = obj.definitions;
		if ("components" in obj) result.components = obj.components;
	}
	return result;
}
function inlineLocalToolSchemaRefs(schema) {
	if (!schema || typeof schema !== "object") return schema;
	return inlineLocalSchemaRefsWithDefs(schema, extendSchemaDefs(void 0, schema), void 0, { unresolvedLocalRefs: false }, schema);
}
const OPENAPI_SCHEMA_ANNOTATION_KEYS = new Set([
	"discriminator",
	"externalDocs",
	"readOnly",
	"writeOnly",
	"xml",
	"example"
]);
function appendNullSchemaType(type) {
	if (type === "null") return type;
	if (typeof type === "string") return [type, "null"];
	if (Array.isArray(type)) return type.includes("null") ? type : [...type, "null"];
	return type;
}
function isNullSchemaLike(schema) {
	if (!isSchemaRecord(schema)) return false;
	if (schema.type === "null") return true;
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	if ("const" in schema && schema.const === null) return true;
	return Array.isArray(schema.enum) && schema.enum.includes(null);
}
function hasOpenApiComposition(schema) {
	return [
		"allOf",
		"anyOf",
		"oneOf"
	].some((key) => Array.isArray(schema[key]));
}
function schemaCompositionAlreadyAllowsNull(schema) {
	return Array.isArray(schema.anyOf) && schema.anyOf.some(isNullSchemaLike) || Array.isArray(schema.oneOf) && schema.oneOf.some(isNullSchemaLike);
}
function wrapNullableComposedSchema(schema) {
	if (schemaCompositionAlreadyAllowsNull(schema)) return schema;
	const wrapped = { anyOf: [schema, { type: "null" }] };
	copySchemaMeta(schema, wrapped);
	return wrapped;
}
function normalizeOpenApiSchemaKeywords(schema) {
	if (Array.isArray(schema)) {
		let changed = false;
		const normalized = schema.map((entry) => {
			const next = normalizeOpenApiSchemaKeywords(entry);
			changed ||= next !== entry;
			return next;
		});
		return changed ? normalized : schema;
	}
	if (!isSchemaRecord(schema)) return schema;
	let changed = false;
	const nullable = schema.nullable === true;
	const normalized = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "nullable" || OPENAPI_SCHEMA_ANNOTATION_KEYS.has(key)) {
			changed = true;
			continue;
		}
		if (SCHEMA_LITERAL_KEYS.has(key)) {
			normalized[key] = value;
			continue;
		}
		if (SCHEMA_MAP_KEYS.has(key) && isSchemaRecord(value)) {
			let mapChanged = false;
			const next = Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => {
				const nextEntry = normalizeOpenApiSchemaKeywords(entryValue);
				mapChanged ||= nextEntry !== entryValue;
				return [entryKey, nextEntry];
			}));
			normalized[key] = mapChanged ? next : value;
			changed ||= mapChanged;
			continue;
		}
		if (key === "components") {
			normalized[key] = value;
			continue;
		}
		if (SCHEMA_OBJECT_KEYS.has(key) && isSchemaRecord(value)) {
			const next = normalizeOpenApiSchemaKeywords(value);
			normalized[key] = next;
			changed ||= next !== value;
			continue;
		}
		if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
			const next = value.map(normalizeOpenApiSchemaKeywords);
			normalized[key] = next;
			changed ||= next.some((entry, index) => entry !== value[index]);
			continue;
		}
		normalized[key] = value;
	}
	if (nullable) {
		if (hasOpenApiComposition(normalized)) return wrapNullableComposedSchema(normalized);
		if ("type" in normalized) {
			const nextType = appendNullSchemaType(normalized.type);
			if (nextType !== normalized.type) normalized.type = nextType;
		}
		if (Array.isArray(normalized.enum) && !normalized.enum.includes(null)) normalized.enum = [...normalized.enum, null];
	}
	return changed || nullable ? normalized : schema;
}
function normalizeToolParameterSchema(schema, options) {
	const inlinedSchema = normalizeOpenApiSchemaKeywords(inlineLocalToolSchemaRefs(schema));
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
