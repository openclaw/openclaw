import JSON5 from "json5";
//#region src/utils/parse-json-compat.ts
function parseJsonWithJson5Fallback(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return JSON5.parse(raw);
	}
}
//#endregion
export { parseJsonWithJson5Fallback as t };
