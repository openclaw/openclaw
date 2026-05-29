import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
//#region packages/llm-core/src/validation.ts
const validatorCache = /* @__PURE__ */ new WeakMap();
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function isJsonSchemaObject(value) {
	return isRecord(value);
}
function hasTypeBoxMetadata(schema) {
	return isRecord(schema) && Object.getOwnPropertySymbols(schema).includes(TYPEBOX_KIND);
}
function getSchemaTypes(schema) {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) return schema.type.filter((type) => typeof type === "string");
	return [];
}
function matchesJsonType(value, type) {
	switch (type) {
		case "number": return typeof value === "number";
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "string": return typeof value === "string";
		case "null": return value === null;
		case "array": return Array.isArray(value);
		case "object": return isRecord(value) && !Array.isArray(value);
		default: return false;
	}
}
function isValidatorSchema(value) {
	return isRecord(value);
}
const JSON_NUMBER_TOKEN_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/iu;
function parseJsonNumberString(value) {
	const trimmed = value.trim();
	if (!trimmed || !JSON_NUMBER_TOKEN_RE.test(trimmed)) return;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function parseJsonIntegerString(value) {
	const parsed = parseJsonNumberString(value);
	return parsed !== void 0 && Number.isSafeInteger(parsed) ? parsed : void 0;
}
function getSubSchemaValidator(schema) {
	if (!isValidatorSchema(schema)) return;
	try {
		return getValidator(schema);
	} catch {
		return;
	}
}
function coercePrimitiveByType(value, type) {
	switch (type) {
		case "number":
			if (value === null) return 0;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = parseJsonNumberString(value);
				if (parsed !== void 0) return parsed;
			}
			if (typeof value === "boolean") return value ? 1 : 0;
			return value;
		case "integer":
			if (value === null) return 0;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = parseJsonIntegerString(value);
				if (parsed !== void 0) return parsed;
			}
			if (typeof value === "boolean") return value ? 1 : 0;
			return value;
		case "boolean":
			if (value === null) return false;
			if (typeof value === "string") {
				if (value === "true") return true;
				if (value === "false") return false;
			}
			if (typeof value === "number") {
				if (value === 1) return true;
				if (value === 0) return false;
			}
			return value;
		case "string":
			if (value === null) return "";
			if (typeof value === "number" || typeof value === "boolean") return String(value);
			return value;
		case "null":
			if (value === "" || value === 0 || value === false) return null;
			return value;
		default: return value;
	}
}
function applySchemaObjectCoercion(value, schema) {
	const properties = schema.properties;
	const definedKeys = new Set(properties ? Object.keys(properties) : []);
	if (properties) {
		for (const [key, propertySchema] of Object.entries(properties)) if (key in value) value[key] = coerceWithJsonSchema(value[key], propertySchema);
	}
	if (schema.additionalProperties && isJsonSchemaObject(schema.additionalProperties)) {
		for (const [key, propertyValue] of Object.entries(value)) if (!definedKeys.has(key)) value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
	}
}
function applySchemaArrayCoercion(value, schema) {
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (itemSchema) value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}
	if (isJsonSchemaObject(schema.items)) for (let index = 0; index < value.length; index++) value[index] = coerceWithJsonSchema(value[index], schema.items);
}
function coerceWithUnionSchema(value, schemas) {
	for (const schema of schemas) {
		const coerced = coerceWithJsonSchema(structuredClone(value), schema);
		if (getSubSchemaValidator(schema)?.Check(coerced)) return coerced;
	}
	return value;
}
function coerceWithJsonSchema(value, schema) {
	let nextValue = value;
	if (Array.isArray(schema.allOf)) for (const nested of schema.allOf) nextValue = coerceWithJsonSchema(nextValue, nested);
	if (Array.isArray(schema.anyOf)) nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	if (Array.isArray(schema.oneOf)) nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	const schemaTypes = getSchemaTypes(schema);
	const matchesUnionMember = schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) for (const schemaType of schemaTypes) {
		const candidate = coercePrimitiveByType(nextValue, schemaType);
		if (candidate !== nextValue) {
			nextValue = candidate;
			break;
		}
	}
	if (schemaTypes.includes("object") && isRecord(nextValue) && !Array.isArray(nextValue)) applySchemaObjectCoercion(nextValue, schema);
	if (schemaTypes.includes("array") && Array.isArray(nextValue)) applySchemaArrayCoercion(nextValue, schema);
	return nextValue;
}
function getValidator(schema) {
	const key = schema;
	const cached = validatorCache.get(key);
	if (cached) return cached;
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}
function formatValidationPath(error) {
	if (error.keyword === "required") {
		const requiredProperty = error.params.requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	return error.instancePath.replace(/^\//, "").replace(/\//g, ".") || "root";
}
function validateToolCall(tools, toolCall) {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) throw new Error(`Tool "${toolCall.name}" not found`);
	return validateToolArguments(tool, toolCall);
}
function validateToolArguments(tool, toolCall) {
	const args = structuredClone(toolCall.arguments);
	Value.Convert(tool.parameters, args);
	const validator = getValidator(tool.parameters);
	if (!hasTypeBoxMetadata(tool.parameters) && isJsonSchemaObject(tool.parameters)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters);
		if (coerced !== args) if (isRecord(args) && isRecord(coerced)) {
			for (const key of Object.keys(args)) delete args[key];
			Object.assign(args, coerced);
		} else return validator.Check(coerced) ? coerced : args;
	}
	if (validator.Check(args)) return args;
	const errors = validator.Errors(args).map((error) => `  - ${formatValidationPath(error)}: ${error.message}`).join("\n") || "Unknown validation error";
	throw new Error(`Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`);
}
//#endregion
export { validateToolArguments, validateToolCall };
