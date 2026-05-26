import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as normalizeAnyChannelId } from "./registry-CtWyD2pE.js";
import { t as getLoadedChannelPluginById } from "./registry-loaded-BE-rpJc1.js";
//#region src/auto-reply/reply/group-id-simple.ts
function extractSimpleExplicitGroupId(raw) {
	const trimmed = normalizeOptionalString(raw) ?? "";
	if (!trimmed) return;
	const parts = trimmed.split(":").filter(Boolean);
	if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) return parts.slice(2).join(":").replace(/:topic:.*$/, "") || void 0;
	if (parts.length >= 2 && (parts[0] === "group" || parts[0] === "channel")) return parts.slice(1).join(":").replace(/:topic:.*$/, "") || void 0;
}
//#endregion
//#region src/auto-reply/reply/group-id.ts
function extractExplicitGroupId(raw) {
	const trimmed = normalizeOptionalString(raw) ?? "";
	if (!trimmed) return;
	const simple = extractSimpleExplicitGroupId(trimmed);
	if (simple) return simple;
	const firstPart = trimmed.split(":").find(Boolean);
	const channelId = normalizeAnyChannelId(firstPart ?? "") ?? normalizeOptionalLowercaseString(firstPart);
	const parsed = (channelId ? getLoadedChannelPluginById(channelId)?.messaging : void 0)?.parseExplicitTarget?.({ raw: trimmed }) ?? null;
	if (parsed && parsed.chatType && parsed.chatType !== "direct") return parsed.to.replace(/:topic:.*$/, "") || void 0;
}
//#endregion
export { extractExplicitGroupId as t };
