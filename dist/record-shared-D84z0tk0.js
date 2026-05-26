import { t as hasNonEmptyString$1 } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/browser/src/record-shared.ts
const hasNonEmptyString = hasNonEmptyString$1;
function normalizeString(value) {
	if (typeof value === "string") return value.trim() || void 0;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
}
//#endregion
export { normalizeString as n, hasNonEmptyString as t };
