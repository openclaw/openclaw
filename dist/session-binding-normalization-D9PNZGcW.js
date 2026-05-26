import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
//#region src/acp/conversation-id.ts
function normalizeConversationText(value) {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return `${value}`.trim();
	return "";
}
//#endregion
//#region src/infra/outbound/session-binding-normalization.ts
function normalizeConversationTargetRef(ref) {
	const conversationId = normalizeOptionalString(ref.conversationId) ?? "";
	const parentConversationId = normalizeOptionalString(ref.parentConversationId);
	const { parentConversationId: _ignoredParentConversationId, ...rest } = ref;
	return {
		...rest,
		conversationId,
		...parentConversationId && parentConversationId !== conversationId ? { parentConversationId } : {}
	};
}
function normalizeConversationRef(ref) {
	return {
		...normalizeConversationTargetRef(ref),
		channel: normalizeLowercaseStringOrEmpty(ref.channel),
		accountId: normalizeAccountId(ref.accountId)
	};
}
function buildChannelAccountKey(params) {
	return `${normalizeLowercaseStringOrEmpty(params.channel)}:${normalizeAccountId(params.accountId)}`;
}
//#endregion
export { normalizeConversationText as i, normalizeConversationRef as n, normalizeConversationTargetRef as r, buildChannelAccountKey as t };
