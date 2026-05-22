import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
//#region src/plugin-sdk/boolean-param.ts
/** Read loose boolean params from tool input that may arrive as booleans or "true"/"false" strings. */
function readBooleanParam(params, key) {
	const raw = params[key];
	if (typeof raw === "boolean") return raw;
	const normalized = normalizeOptionalLowercaseString(raw);
	if (normalized === "true") return true;
	if (normalized === "false") return false;
}
//#endregion
export { readBooleanParam as t };
