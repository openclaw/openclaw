import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/voice-call/src/http-headers.ts
function getHeader(headers, name) {
	const target = normalizeLowercaseStringOrEmpty(name);
	const value = headers[target] ?? Object.entries(headers).find(([key]) => normalizeLowercaseStringOrEmpty(key) === target)?.[1];
	if (Array.isArray(value)) return value[0];
	return value;
}
//#endregion
export { getHeader as t };
