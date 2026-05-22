import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/channels/thread-binding-id.ts
function resolveThreadBindingConversationIdFromBindingId(params) {
	const bindingId = normalizeOptionalString(params.bindingId);
	if (!bindingId) return;
	const prefix = `${params.accountId}:`;
	if (!bindingId.startsWith(prefix)) return;
	return normalizeOptionalString(bindingId.slice(prefix.length)) || void 0;
}
//#endregion
export { resolveThreadBindingConversationIdFromBindingId as t };
