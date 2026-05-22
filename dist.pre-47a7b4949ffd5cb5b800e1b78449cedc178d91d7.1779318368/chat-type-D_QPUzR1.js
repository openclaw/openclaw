import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
//#region src/channels/chat-type.ts
function normalizeChatType(raw) {
	const value = normalizeOptionalLowercaseString(raw);
	if (!value) return;
	if (value === "direct" || value === "dm") return "direct";
	if (value === "group") return "group";
	if (value === "channel") return "channel";
}
//#endregion
export { normalizeChatType as t };
