import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
//#region src/channels/conversation-label.ts
function extractConversationId(from) {
	const trimmed = normalizeOptionalString(from);
	if (!trimmed) return;
	const parts = trimmed.split(":").filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}
function shouldAppendId(id) {
	if (/^[0-9]+$/.test(id)) return true;
	if (/^[^\s:@]+@[^\s:@]+$/.test(id)) return true;
	return false;
}
function resolveConversationLabel(ctx) {
	const explicit = normalizeOptionalString(ctx.ConversationLabel);
	if (explicit) return explicit;
	const threadLabel = normalizeOptionalString(ctx.ThreadLabel);
	if (threadLabel) return threadLabel;
	if (normalizeChatType(ctx.ChatType) === "direct") return normalizeOptionalString(ctx.SenderName) ?? normalizeOptionalString(ctx.From);
	const base = normalizeOptionalString(ctx.GroupChannel) || normalizeOptionalString(ctx.GroupSubject) || normalizeOptionalString(ctx.GroupSpace) || normalizeOptionalString(ctx.From) || "";
	if (!base) return;
	const id = extractConversationId(ctx.From);
	if (!id) return base;
	if (!shouldAppendId(id)) return base;
	if (base === id) return base;
	if (base.includes(id)) return base;
	if (normalizeLowercaseStringOrEmpty(base).includes(" id:")) return base;
	if (base.startsWith("#") || base.startsWith("@")) return base;
	return `${base} id:${id}`;
}
//#endregion
export { resolveConversationLabel as t };
