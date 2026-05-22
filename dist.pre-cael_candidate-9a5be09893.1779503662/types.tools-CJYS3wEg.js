import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
//#region src/config/types.tools.ts
const TOOLS_BY_SENDER_KEY_TYPES = [
	"channel",
	"id",
	"e164",
	"username",
	"name"
];
function parseToolsBySenderTypedKey(rawKey) {
	const trimmed = rawKey.trim();
	if (!trimmed) return;
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	for (const type of TOOLS_BY_SENDER_KEY_TYPES) {
		const prefix = `${type}:`;
		if (!lowered.startsWith(prefix)) continue;
		return {
			type,
			value: trimmed.slice(prefix.length)
		};
	}
}
//#endregion
export { parseToolsBySenderTypedKey as n, TOOLS_BY_SENDER_KEY_TYPES as t };
