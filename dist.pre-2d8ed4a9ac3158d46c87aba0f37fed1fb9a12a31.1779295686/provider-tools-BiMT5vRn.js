//#region src/agents/schema/clean-for-gemini.ts
const GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
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
	"not"
]);
const SCHEMA_META_KEYS = [
	"description",
	"title",
	"default"
];
function copySchemaMeta(from, to) {
	for (const key of SCHEMA_META_KEYS) if (key in from && from[key] !== void 0) to[key] = from[key];
}
function tryFlattenLiteralAnyOf(variants) {
	if (variants.length === 0) return null;
	const allValues = [];
	let commonType = null;
	for (const variant of variants) {
		if (!variant || typeof variant !== "object") return null;
		const v = variant;
		let literalValue;
		if ("const" in v) literalValue = v.const;
		else if (Array.isArray(v.enum) && v.enum.length === 1) literalValue = v.enum[0];
		else return null;
		const variantType = typeof v.type === "string" ? v.type : null;
		if (!variantType) return null;
		if (commonType === null) commonType = variantType;
		else if (commonType !== variantType) return null;
		allValues.push(literalValue);
	}
	if (commonType && allValues.length > 0) return {
		type: commonType,
		enum: allValues
	};
	return null;
}
function isNullSchema(variant) {
	if (!variant || typeof variant !== "object" || Array.isArray(variant)) return false;
	const record = variant;
	if ("const" in record && record.const === null) return true;
	if (Array.isArray(record.enum) && record.enum.length === 1) return record.enum[0] === null;
	const typeValue = record.type;
	if (typeValue === "null") return true;
	if (Array.isArray(typeValue) && typeValue.length === 1 && typeValue[0] === "null") return true;
	return false;
}
function stripNullVariants(variants) {
	if (variants.length === 0) return {
		variants,
		stripped: false
	};
	const nonNull = variants.filter((variant) => !isNullSchema(variant));
	return {
		variants: nonNull,
		stripped: nonNull.length !== variants.length
	};
}
function extendSchemaDefs(defs, schema) {
	const defsEntry = schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs) ? schema.$defs : void 0;
	const legacyDefsEntry = schema.definitions && typeof schema.definitions === "object" && !Array.isArray(schema.definitions) ? schema.definitions : void 0;
	if (!defsEntry && !legacyDefsEntry) return defs;
	const next = defs ? new Map(defs) : /* @__PURE__ */ new Map();
	if (defsEntry) for (const [key, value] of Object.entries(defsEntry)) next.set(key, value);
	if (legacyDefsEntry) for (const [key, value] of Object.entries(legacyDefsEntry)) next.set(key, value);
	return next;
}
function decodeJsonPointerSegment(segment) {
	return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}
function tryResolveLocalRef(ref, defs) {
	if (!defs) return;
	const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
	if (!match) return;
	const name = decodeJsonPointerSegment(match[1] ?? "");
	if (!name) return;
	return defs.get(name);
}
function simplifyUnionVariants(params) {
	const { obj, variants } = params;
	const { variants: nonNullVariants, stripped } = stripNullVariants(variants);
	const flattened = tryFlattenLiteralAnyOf(nonNullVariants);
	if (flattened) {
		const result = {
			type: flattened.type,
			enum: flattened.enum
		};
		copySchemaMeta(obj, result);
		return {
			variants: nonNullVariants,
			simplified: result
		};
	}
	if (stripped && nonNullVariants.length === 1) {
		const lone = nonNullVariants[0];
		if (lone && typeof lone === "object" && !Array.isArray(lone)) {
			const result = { ...lone };
			copySchemaMeta(obj, result);
			return {
				variants: nonNullVariants,
				simplified: result
			};
		}
		return {
			variants: nonNullVariants,
			simplified: lone
		};
	}
	return { variants: stripped ? nonNullVariants : variants };
}
function sanitizeRequiredFields(schema) {
	if (!Array.isArray(schema.required)) return schema;
	if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
		if (schema.type === "object") delete schema.required;
		return schema;
	}
	const properties = schema.properties;
	const required = schema.required.filter((key) => typeof key === "string" && Object.hasOwn(properties, key));
	if (required.length > 0) schema.required = required;
	else delete schema.required;
	return schema;
}
function cleanSchemaForGeminiWithDefs(schema, defs, refStack) {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map((item) => cleanSchemaForGeminiWithDefs(item, defs, refStack));
	const obj = schema;
	const nextDefs = extendSchemaDefs(defs, obj);
	const refValue = typeof obj.$ref === "string" ? obj.$ref : void 0;
	if (refValue) {
		if (refStack?.has(refValue)) return {};
		const resolved = tryResolveLocalRef(refValue, nextDefs);
		if (resolved) {
			const nextRefStack = refStack ? new Set(refStack) : /* @__PURE__ */ new Set();
			nextRefStack.add(refValue);
			const cleaned = cleanSchemaForGeminiWithDefs(resolved, nextDefs, nextRefStack);
			if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) return cleaned;
			const result = { ...cleaned };
			copySchemaMeta(obj, result);
			return result;
		}
		const result = {};
		copySchemaMeta(obj, result);
		return result;
	}
	const hasAnyOf = "anyOf" in obj && Array.isArray(obj.anyOf);
	const hasOneOf = "oneOf" in obj && Array.isArray(obj.oneOf);
	let cleanedAnyOf = hasAnyOf ? obj.anyOf.map((variant) => cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack)) : void 0;
	let cleanedOneOf = hasOneOf ? obj.oneOf.map((variant) => cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack)) : void 0;
	if (hasAnyOf) {
		const simplified = simplifyUnionVariants({
			obj,
			variants: cleanedAnyOf ?? []
		});
		cleanedAnyOf = simplified.variants;
		if ("simplified" in simplified) return simplified.simplified;
	}
	if (hasOneOf) {
		const simplified = simplifyUnionVariants({
			obj,
			variants: cleanedOneOf ?? []
		});
		cleanedOneOf = simplified.variants;
		if ("simplified" in simplified) return simplified.simplified;
	}
	const cleaned = {};
	for (const [key, value] of Object.entries(obj)) {
		if (GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
		if (key === "const") {
			cleaned.enum = [value];
			continue;
		}
		if (key === "required" && Array.isArray(value) && value.length === 0) continue;
		if (key === "type" && (hasAnyOf || hasOneOf)) continue;
		if (key === "type" && Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
			const types = value.filter((entry) => entry !== "null");
			cleaned.type = types.length === 1 ? types[0] : types;
			continue;
		}
		if (key === "properties") if (value && typeof value === "object" && !Array.isArray(value)) cleaned[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanSchemaForGeminiWithDefs(v, nextDefs, refStack)]));
		else cleaned[key] = {};
		else if (key === "items" && value) if (Array.isArray(value)) cleaned[key] = value.map((entry) => cleanSchemaForGeminiWithDefs(entry, nextDefs, refStack));
		else if (typeof value === "object") cleaned[key] = cleanSchemaForGeminiWithDefs(value, nextDefs, refStack);
		else cleaned[key] = value;
		else if (key === "anyOf" && Array.isArray(value)) cleaned[key] = cleanedAnyOf ?? value.map((variant) => cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack));
		else if (key === "oneOf" && Array.isArray(value)) cleaned[key] = cleanedOneOf ?? value.map((variant) => cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack));
		else if (key === "allOf" && Array.isArray(value)) cleaned[key] = value.map((variant) => cleanSchemaForGeminiWithDefs(variant, nextDefs, refStack));
		else cleaned[key] = value;
	}
	if (cleaned.anyOf && Array.isArray(cleaned.anyOf)) {
		const flattened = flattenUnionFallback(cleaned, cleaned.anyOf);
		if (flattened) return sanitizeRequiredFields(flattened);
	}
	if (cleaned.oneOf && Array.isArray(cleaned.oneOf)) {
		const flattened = flattenUnionFallback(cleaned, cleaned.oneOf);
		if (flattened) return sanitizeRequiredFields(flattened);
	}
	return sanitizeRequiredFields(cleaned);
}
/**
* Last-resort flattening for anyOf/oneOf arrays that could not be simplified
* by `simplifyUnionVariants`. Picks a representative type so the schema is
* accepted by Google's restricted JSON Schema validation.
*/
function flattenUnionFallback(obj, variants) {
	const objects = variants.filter((v) => !!v && typeof v === "object");
	if (objects.length === 0) return;
	const types = new Set(objects.map((v) => v.type).filter(Boolean));
	if (objects.length === 1) {
		const merged = { ...objects[0] };
		copySchemaMeta(obj, merged);
		return merged;
	}
	if (types.size === 1) {
		const merged = { type: Array.from(types)[0] };
		copySchemaMeta(obj, merged);
		return merged;
	}
	const first = objects[0];
	if (first?.type) {
		const merged = { type: first.type };
		copySchemaMeta(obj, merged);
		return merged;
	}
	const merged = {};
	copySchemaMeta(obj, merged);
	return merged;
}
function cleanSchemaForGemini(schema) {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);
	return cleanSchemaForGeminiWithDefs(schema, extendSchemaDefs(void 0, schema), void 0);
}
//#endregion
//#region src/plugin-sdk/provider-tools.ts
function stripUnsupportedSchemaKeywords(schema, unsupportedKeywords) {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupportedKeywords));
	const obj = schema;
	const cleaned = {};
	for (const [key, value] of Object.entries(obj)) {
		if (unsupportedKeywords.has(key)) continue;
		if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
			cleaned[key] = Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, stripUnsupportedSchemaKeywords(childValue, unsupportedKeywords)]));
			continue;
		}
		if (key === "items" && value && typeof value === "object") {
			cleaned[key] = Array.isArray(value) ? value.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupportedKeywords)) : stripUnsupportedSchemaKeywords(value, unsupportedKeywords);
			continue;
		}
		if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
			cleaned[key] = value.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupportedKeywords));
			continue;
		}
		cleaned[key] = value;
	}
	return cleaned;
}
function findUnsupportedSchemaKeywords(schema, path, unsupportedKeywords) {
	if (!schema || typeof schema !== "object") return [];
	if (Array.isArray(schema)) return schema.flatMap((item, index) => findUnsupportedSchemaKeywords(item, `${path}[${index}]`, unsupportedKeywords));
	const record = schema;
	const violations = [];
	const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) ? record.properties : void 0;
	if (properties) for (const [key, value] of Object.entries(properties)) violations.push(...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`, unsupportedKeywords));
	for (const [key, value] of Object.entries(record)) {
		if (key === "properties") continue;
		if (unsupportedKeywords.has(key)) violations.push(`${path}.${key}`);
		if (value && typeof value === "object") violations.push(...findUnsupportedSchemaKeywords(value, `${path}.${key}`, unsupportedKeywords));
	}
	return violations;
}
function normalizeGeminiToolSchemas(ctx) {
	return ctx.tools.map((tool) => {
		if (!tool.parameters || typeof tool.parameters !== "object") return tool;
		return {
			...tool,
			parameters: cleanSchemaForGemini(tool.parameters)
		};
	});
}
function inspectGeminiToolSchemas(ctx) {
	return ctx.tools.flatMap((tool, toolIndex) => {
		const violations = findUnsupportedSchemaKeywords(tool.parameters, `${tool.name}.parameters`, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS);
		if (violations.length === 0) return [];
		return [{
			toolName: tool.name,
			toolIndex,
			violations
		}];
	});
}
function normalizeOpenAIToolSchemas(ctx) {
	if (!shouldApplyOpenAIToolCompat(ctx)) return ctx.tools;
	return ctx.tools.map((tool) => {
		if (tool.parameters == null) return {
			...tool,
			parameters: normalizeOpenAIStrictCompatSchema({})
		};
		if (typeof tool.parameters !== "object") return tool;
		return {
			...tool,
			parameters: normalizeOpenAIStrictCompatSchema(tool.parameters)
		};
	});
}
function normalizeOpenAIStrictCompatSchema(schema) {
	return normalizeOpenAIStrictCompatSchemaRecursive(schema, { promoteEmptyObject: true });
}
function shouldApplyOpenAIToolCompat(ctx) {
	const provider = (ctx.model?.provider ?? ctx.provider ?? "").trim().toLowerCase();
	const api = (ctx.model?.api ?? ctx.modelApi ?? "").trim().toLowerCase();
	const baseUrl = (ctx.model?.baseUrl ?? "").trim().toLowerCase();
	if (provider === "openai") return api === "openai-responses" && (!baseUrl || isOpenAIResponsesBaseUrl(baseUrl));
	if (provider === "openai-codex") return api === "openai-codex-responses" && (!baseUrl || isOpenAIResponsesBaseUrl(baseUrl) || isOpenAICodexBaseUrl(baseUrl));
	return false;
}
function isOpenAIResponsesBaseUrl(baseUrl) {
	return /^https:\/\/api\.openai\.com(?:\/v1)?(?:\/|$)/i.test(baseUrl);
}
function isOpenAICodexBaseUrl(baseUrl) {
	return /^https:\/\/chatgpt\.com\/backend-api(?:\/|$)/i.test(baseUrl);
}
const OPENAI_STRICT_COMPAT_SCHEMA_MAP_KEYS = new Set([
	"$defs",
	"definitions",
	"dependentSchemas",
	"patternProperties",
	"properties"
]);
const OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS = new Set([
	"additionalProperties",
	"allOf",
	"anyOf",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"oneOf",
	"prefixItems",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties"
]);
function normalizeOpenAIStrictCompatSchemaMap(schema) {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
	let changed = false;
	const normalized = {};
	for (const [key, value] of Object.entries(schema)) {
		const next = normalizeOpenAIStrictCompatSchemaRecursive(value, { promoteEmptyObject: false });
		normalized[key] = next;
		changed ||= next !== value;
	}
	return changed ? normalized : schema;
}
function normalizeOpenAIStrictCompatSchemaRecursive(schema, options) {
	if (Array.isArray(schema)) {
		let changed = false;
		const normalized = schema.map((entry) => {
			const next = normalizeOpenAIStrictCompatSchemaRecursive(entry, { promoteEmptyObject: false });
			changed ||= next !== entry;
			return next;
		});
		return changed ? normalized : schema;
	}
	if (!schema || typeof schema !== "object") return schema;
	const record = schema;
	let changed = false;
	const normalized = {};
	for (const [key, value] of Object.entries(record)) {
		const next = OPENAI_STRICT_COMPAT_SCHEMA_MAP_KEYS.has(key) ? normalizeOpenAIStrictCompatSchemaMap(value) : OPENAI_STRICT_COMPAT_SCHEMA_NESTED_KEYS.has(key) ? normalizeOpenAIStrictCompatSchemaRecursive(value, { promoteEmptyObject: false }) : value;
		normalized[key] = next;
		changed ||= next !== value;
	}
	if (Object.keys(normalized).length === 0) {
		if (!options.promoteEmptyObject) return schema;
		return {
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false
		};
	}
	if (!("type" in normalized) && (normalized.properties && typeof normalized.properties === "object" && !Array.isArray(normalized.properties) || Array.isArray(normalized.required))) {
		normalized.type = "object";
		changed = true;
	}
	if (normalized.type === "object" && !("properties" in normalized)) {
		normalized.properties = {};
		changed = true;
	}
	const hasEmptyProperties = normalized.properties && typeof normalized.properties === "object" && !Array.isArray(normalized.properties) && Object.keys(normalized.properties).length === 0;
	if (normalized.type === "object" && !Array.isArray(normalized.required) && hasEmptyProperties) {
		normalized.required = [];
		changed = true;
	}
	if (normalized.type === "object" && hasEmptyProperties && !("additionalProperties" in normalized)) {
		normalized.additionalProperties = false;
		changed = true;
	}
	return changed ? normalized : schema;
}
function findOpenAIStrictSchemaViolations(schema, path, options) {
	if (Array.isArray(schema)) {
		if (options?.requireObjectRoot) return [`${path}.type`];
		return schema.flatMap((item, index) => findOpenAIStrictSchemaViolations(item, `${path}[${index}]`));
	}
	if (!schema || typeof schema !== "object") {
		if (options?.requireObjectRoot) return [`${path}.type`];
		return [];
	}
	const record = schema;
	const violations = [];
	for (const key of [
		"anyOf",
		"oneOf",
		"allOf"
	]) if (Array.isArray(record[key])) violations.push(`${path}.${key}`);
	if (Array.isArray(record.type)) violations.push(`${path}.type`);
	const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) ? record.properties : void 0;
	if (record.type === "object") {
		if (record.additionalProperties !== false) violations.push(`${path}.additionalProperties`);
		const required = Array.isArray(record.required) ? record.required.filter((entry) => typeof entry === "string") : void 0;
		if (!required) violations.push(`${path}.required`);
		else if (properties) {
			const requiredSet = new Set(required);
			for (const key of Object.keys(properties)) if (!requiredSet.has(key)) violations.push(`${path}.required.${key}`);
		}
	}
	if (properties) for (const [key, value] of Object.entries(properties)) violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.properties.${key}`));
	for (const [key, value] of Object.entries(record)) {
		if (key === "properties") continue;
		if (value && typeof value === "object") violations.push(...findOpenAIStrictSchemaViolations(value, `${path}.${key}`));
	}
	return violations;
}
function inspectOpenAIToolSchemas(ctx) {
	if (!shouldApplyOpenAIToolCompat(ctx)) return [];
	return [];
}
const DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(["anyOf", "oneOf"]);
function isNullSchemaVariant(schema) {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const record = schema;
	if (record.type === "null") return true;
	if (Array.isArray(record.type) && record.type.length === 1 && record.type[0] === "null") return true;
	if ("const" in record && record.const === null) return true;
	return Array.isArray(record.enum) && record.enum.length === 1 && record.enum[0] === null;
}
function normalizeDeepSeekSchema(schema) {
	if (Array.isArray(schema)) {
		let changed = false;
		const normalized = schema.map((entry) => {
			const next = normalizeDeepSeekSchema(entry);
			changed ||= next !== entry;
			return next;
		});
		return changed ? normalized : schema;
	}
	if (!schema || typeof schema !== "object") return schema;
	const record = schema;
	const unionKey = Array.isArray(record.anyOf) ? "anyOf" : Array.isArray(record.oneOf) ? "oneOf" : void 0;
	let changed = false;
	const normalized = {};
	for (const [key, value] of Object.entries(record)) {
		if (key === "anyOf" || key === "oneOf") {
			if (key === unionKey) {
				changed = true;
				continue;
			}
		}
		const next = normalizeDeepSeekSchema(value);
		normalized[key] = next;
		changed ||= next !== value;
	}
	if (!unionKey) return changed ? normalized : schema;
	const normalizedVariants = record[unionKey].map((entry) => normalizeDeepSeekSchema(entry));
	const nonNullVariants = normalizedVariants.filter((entry) => !isNullSchemaVariant(entry));
	const selected = nonNullVariants[0] ?? normalizedVariants[0];
	if (!selected || typeof selected !== "object" || Array.isArray(selected)) return normalized;
	const merged = {
		...selected,
		...normalized
	};
	if (nonNullVariants.length < normalizedVariants.length) merged.nullable = true;
	return merged;
}
function normalizeDeepSeekToolSchemas(ctx) {
	return ctx.tools.map((tool) => {
		if (!tool.parameters || typeof tool.parameters !== "object") return tool;
		const parameters = normalizeDeepSeekSchema(tool.parameters);
		return parameters === tool.parameters ? tool : {
			...tool,
			parameters
		};
	});
}
function inspectDeepSeekToolSchemas(ctx) {
	return ctx.tools.flatMap((tool, toolIndex) => {
		const violations = findUnsupportedSchemaKeywords(tool.parameters, `${tool.name}.parameters`, DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS);
		if (violations.length === 0) return [];
		return [{
			toolName: tool.name,
			toolIndex,
			violations
		}];
	});
}
function buildProviderToolCompatFamilyHooks(family) {
	switch (family) {
		case "deepseek": return {
			normalizeToolSchemas: normalizeDeepSeekToolSchemas,
			inspectToolSchemas: inspectDeepSeekToolSchemas
		};
		case "gemini": return {
			normalizeToolSchemas: normalizeGeminiToolSchemas,
			inspectToolSchemas: inspectGeminiToolSchemas
		};
		case "openai": return {
			normalizeToolSchemas: normalizeOpenAIToolSchemas,
			inspectToolSchemas: inspectOpenAIToolSchemas
		};
	}
	throw new Error("Unsupported provider tool compatibility family");
}
//#endregion
export { inspectDeepSeekToolSchemas as a, normalizeDeepSeekToolSchemas as c, stripUnsupportedSchemaKeywords as d, GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS as f, findUnsupportedSchemaKeywords as i, normalizeGeminiToolSchemas as l, buildProviderToolCompatFamilyHooks as n, inspectGeminiToolSchemas as o, cleanSchemaForGemini as p, findOpenAIStrictSchemaViolations as r, inspectOpenAIToolSchemas as s, DEEPSEEK_UNSUPPORTED_SCHEMA_KEYWORDS as t, normalizeOpenAIToolSchemas as u };
