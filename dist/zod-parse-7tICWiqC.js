//#region src/utils/zod-parse.ts
function safeParseWithSchema(schema, value) {
	const parsed = schema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
function safeParseJsonWithSchema(schema, raw) {
	try {
		return safeParseWithSchema(schema, JSON.parse(raw));
	} catch {
		return null;
	}
}
//#endregion
export { safeParseWithSchema as n, safeParseJsonWithSchema as t };
