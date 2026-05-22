import { t as validateJsonSchemaValue } from "./schema-validator-CoHaB3Uu.js";
//#region src/plugins/config-schema.ts
function error(message) {
	return {
		success: false,
		error: { issues: [{
			path: [],
			message
		}] }
	};
}
function cloneIssue(issue) {
	return {
		path: issue.path.filter((segment) => {
			const kind = typeof segment;
			return kind === "string" || kind === "number";
		}),
		message: issue.message
	};
}
function safeParseRuntimeSchema(schema, value) {
	const result = schema.safeParse(value);
	if (result.success) return {
		success: true,
		data: result.data
	};
	return {
		success: false,
		error: { issues: result.error.issues.map((issue) => cloneIssue(issue)) }
	};
}
function normalizeJsonSchema(schema) {
	if (Array.isArray(schema)) return schema.map((item) => normalizeJsonSchema(item));
	if (!schema || typeof schema !== "object") return schema;
	const record = { ...schema };
	delete record.$schema;
	for (const [key, value] of Object.entries(record)) record[key] = normalizeJsonSchema(value);
	const propertyNames = record.propertyNames;
	if (propertyNames && typeof propertyNames === "object" && !Array.isArray(propertyNames) && propertyNames.type === "string") delete record.propertyNames;
	if (Array.isArray(record.required) && record.required.length === 0) delete record.required;
	return record;
}
function toIssuePath(path) {
	if (!path || path === "<root>") return [];
	return path.split(".").map((segment) => {
		const index = Number(segment);
		return Number.isInteger(index) && String(index) === segment ? index : segment;
	});
}
function safeParseJsonSchema(schema, cacheKey, value) {
	const result = validateJsonSchemaValue({
		schema,
		cacheKey,
		value,
		applyDefaults: true
	});
	if (result.ok) return {
		success: true,
		data: result.value
	};
	return {
		success: false,
		error: { issues: result.errors.map((issue) => ({
			path: toIssuePath(issue.path),
			message: issue.message
		})) }
	};
}
function buildJsonPluginConfigSchema(schema, options) {
	return {
		safeParse: options?.safeParse ?? ((value) => safeParseJsonSchema(schema, options?.cacheKey ?? "plugin-config-schema:json", value)),
		...options?.uiHints ? { uiHints: options.uiHints } : {},
		jsonSchema: normalizeJsonSchema(schema)
	};
}
function buildPluginConfigSchema(schema, options) {
	const schemaWithJson = schema;
	const safeParse = options?.safeParse ?? ((value) => safeParseRuntimeSchema(schema, value));
	if (typeof schemaWithJson.toJSONSchema === "function") return {
		safeParse,
		...options?.uiHints ? { uiHints: options.uiHints } : {},
		jsonSchema: normalizeJsonSchema(schemaWithJson.toJSONSchema({
			target: "draft-07",
			io: "input",
			unrepresentable: "any"
		}))
	};
	return {
		safeParse,
		...options?.uiHints ? { uiHints: options.uiHints } : {},
		jsonSchema: {
			type: "object",
			additionalProperties: true
		}
	};
}
function emptyPluginConfigSchema() {
	return {
		safeParse(value) {
			if (value === void 0) return {
				success: true,
				data: void 0
			};
			if (!value || typeof value !== "object" || Array.isArray(value)) return error("expected config object");
			if (Object.keys(value).length > 0) return error("config must be empty");
			return {
				success: true,
				data: value
			};
		},
		jsonSchema: {
			type: "object",
			additionalProperties: false,
			properties: {}
		}
	};
}
//#endregion
export { buildPluginConfigSchema as n, emptyPluginConfigSchema as r, buildJsonPluginConfigSchema as t };
