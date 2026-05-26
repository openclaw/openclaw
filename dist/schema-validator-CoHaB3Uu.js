import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as PluginLruCache } from "./plugin-cache-primitives-DcK62VYf.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { createRequire } from "node:module";
//#region src/config/allowed-values.ts
const MAX_ALLOWED_VALUES_HINT = 12;
const MAX_ALLOWED_VALUE_CHARS = 160;
function truncateHintText(text, limit) {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}... (+${text.length - limit} chars)`;
}
function safeStringify(value) {
	try {
		const serialized = JSON.stringify(value);
		if (serialized !== void 0) return serialized;
	} catch {}
	return String(value);
}
function toAllowedValueLabel(value) {
	if (typeof value === "string") return JSON.stringify(truncateHintText(value, MAX_ALLOWED_VALUE_CHARS));
	return truncateHintText(safeStringify(value), MAX_ALLOWED_VALUE_CHARS);
}
function toAllowedValueValue(value) {
	if (typeof value === "string") return value;
	return safeStringify(value);
}
function toAllowedValueDedupKey(value) {
	if (value === null) return "null:null";
	const kind = typeof value;
	if (kind === "string") return `string:${value}`;
	return `${kind}:${safeStringify(value)}`;
}
function summarizeAllowedValues(values) {
	if (values.length === 0) return null;
	const deduped = [];
	const seenValues = /* @__PURE__ */ new Set();
	for (const item of values) {
		const dedupeKey = toAllowedValueDedupKey(item);
		if (seenValues.has(dedupeKey)) continue;
		seenValues.add(dedupeKey);
		deduped.push({
			value: toAllowedValueValue(item),
			label: toAllowedValueLabel(item)
		});
	}
	const shown = deduped.slice(0, MAX_ALLOWED_VALUES_HINT);
	const hiddenCount = deduped.length - shown.length;
	const formattedCore = shown.map((entry) => entry.label).join(", ");
	const formatted = hiddenCount > 0 ? `${formattedCore}, ... (+${hiddenCount} more)` : formattedCore;
	return {
		values: shown.map((entry) => entry.value),
		hiddenCount,
		formatted
	};
}
function messageAlreadyIncludesAllowedValues(message) {
	const lower = normalizeLowercaseStringOrEmpty(message);
	return lower.includes("(allowed:") || lower.includes("expected one of");
}
function appendAllowedValuesHint(message, summary) {
	if (messageAlreadyIncludesAllowedValues(message)) return message;
	return `${message} (allowed: ${summary.formatted})`;
}
//#endregion
//#region src/plugins/schema-validator.ts
const require = createRequire(import.meta.url);
const ajvSingletons = /* @__PURE__ */ new Map();
function createAjv(mode) {
	const ajvModule = require("ajv");
	const instance = new (typeof ajvModule.default === "function" ? ajvModule.default : ajvModule)({
		allErrors: true,
		strict: false,
		removeAdditional: false,
		...mode === "defaults" ? { useDefaults: true } : {}
	});
	instance.addFormat("uri", {
		type: "string",
		validate: (value) => {
			return URL.canParse(value);
		}
	});
	return instance;
}
function getAjv(mode) {
	const cached = ajvSingletons.get(mode);
	if (cached) return cached;
	const instance = createAjv(mode);
	ajvSingletons.set(mode, instance);
	return instance;
}
const schemaCache = new PluginLruCache(512);
function fingerprintSchema(schema) {
	return JSON.stringify(schema);
}
function schemaHasDefaults(schema) {
	if (!schema || typeof schema !== "object") return false;
	if (Array.isArray(schema)) return schema.some((item) => schemaHasDefaults(item));
	const record = schema;
	if (Object.prototype.hasOwnProperty.call(record, "default")) return true;
	return Object.values(record).some((value) => schemaHasDefaults(value));
}
function cloneValidationValue(value) {
	if (value === void 0 || value === null) return value;
	return structuredClone(value);
}
function normalizeAjvPath(instancePath) {
	const path = instancePath?.replace(/^\//, "").replace(/\//g, ".");
	return path && path.length > 0 ? path : "<root>";
}
function appendPathSegment(path, segment) {
	const trimmed = segment.trim();
	if (!trimmed) return path;
	if (path === "<root>") return trimmed;
	return `${path}.${trimmed}`;
}
function resolveMissingProperty(error) {
	if (error.keyword !== "required" && error.keyword !== "dependentRequired" && error.keyword !== "dependencies") return null;
	const missingProperty = error.params.missingProperty;
	return typeof missingProperty === "string" && missingProperty.trim() ? missingProperty : null;
}
function resolveAjvErrorPath(error) {
	const basePath = normalizeAjvPath(error.instancePath);
	const missingProperty = resolveMissingProperty(error);
	if (!missingProperty) return basePath;
	return appendPathSegment(basePath, missingProperty);
}
function extractAllowedValues(error) {
	if (error.keyword === "enum") {
		const allowedValues = error.params.allowedValues;
		return Array.isArray(allowedValues) ? allowedValues : null;
	}
	if (error.keyword === "const") {
		const params = error.params;
		if (!Object.prototype.hasOwnProperty.call(params, "allowedValue")) return null;
		return [params.allowedValue];
	}
	return null;
}
function getAjvAllowedValuesSummary(error) {
	const allowedValues = extractAllowedValues(error);
	if (!allowedValues) return null;
	return summarizeAllowedValues(allowedValues);
}
function resolveAdditionalProperty(error) {
	if (error.keyword !== "additionalProperties") return;
	const additionalProperty = error.params.additionalProperty;
	return typeof additionalProperty === "string" && additionalProperty.trim() ? additionalProperty : void 0;
}
function formatAjvErrors(errors) {
	if (!errors || errors.length === 0) return [{
		path: "<root>",
		message: "invalid config",
		text: "<root>: invalid config"
	}];
	return errors.map((error) => {
		const path = resolveAjvErrorPath(error);
		const baseMessage = error.message ?? "invalid";
		const allowedValuesSummary = getAjvAllowedValuesSummary(error);
		const additionalProperty = resolveAdditionalProperty(error);
		const message = allowedValuesSummary ? appendAllowedValuesHint(baseMessage, allowedValuesSummary) : baseMessage;
		return {
			path,
			message,
			text: `${sanitizeTerminalText(path)}: ${sanitizeTerminalText(message)}`,
			...additionalProperty ? { additionalProperty } : {},
			...allowedValuesSummary ? {
				allowedValues: allowedValuesSummary.values,
				allowedValuesHiddenCount: allowedValuesSummary.hiddenCount
			} : {}
		};
	});
}
function validateJsonSchemaValue(params) {
	if (!(params.cache !== false)) {
		const validate = createAjv(params.applyDefaults ? "defaults" : "default").compile(params.schema);
		const value = params.applyDefaults && schemaHasDefaults(params.schema) ? cloneValidationValue(params.value) : params.value;
		if (validate(value)) return {
			ok: true,
			value
		};
		return {
			ok: false,
			errors: formatAjvErrors(validate.errors)
		};
	}
	const cacheKey = params.applyDefaults ? `${params.cacheKey}::defaults` : params.cacheKey;
	let cached = schemaCache.get(cacheKey);
	const schemaFingerprint = !cached || cached.schema !== params.schema ? fingerprintSchema(params.schema) : void 0;
	if (!cached || cached.schema !== params.schema && cached.schemaFingerprint !== schemaFingerprint) {
		const validate = getAjv(params.applyDefaults ? "defaults" : "default").compile(params.schema);
		cached = {
			hasDefaults: params.applyDefaults ? schemaHasDefaults(params.schema) : false,
			validate,
			schema: params.schema,
			schemaFingerprint: schemaFingerprint ?? fingerprintSchema(params.schema)
		};
		schemaCache.set(cacheKey, cached);
	} else if (cached.schema !== params.schema) cached.schema = params.schema;
	const value = params.applyDefaults && cached.hasDefaults ? cloneValidationValue(params.value) : params.value;
	if (cached.validate(value)) return {
		ok: true,
		value
	};
	return {
		ok: false,
		errors: formatAjvErrors(cached.validate.errors)
	};
}
//#endregion
export { appendAllowedValuesHint as n, summarizeAllowedValues as r, validateJsonSchemaValue as t };
