import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/gateway/server-json.ts
function safeParseJson(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed) return;
	try {
		return JSON.parse(trimmed);
	} catch {
		return { payloadJSON: value };
	}
}
//#endregion
export { safeParseJson as t };
