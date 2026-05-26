import { n as resetAccountScopedConversationBindingsForTests, t as createAccountScopedConversationBindingManager } from "./thread-bindings-runtime-0qymxvw2.js";
//#region extensions/imessage/src/conversation-bindings.ts
const IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for("openclaw.imessageConversationBindingsState");
function toSessionBindingTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "session";
}
function toIMessageTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "acp";
}
function createIMessageConversationBindingManager(params) {
	return createAccountScopedConversationBindingManager({
		channel: "imessage",
		cfg: params.cfg,
		accountId: params.accountId,
		stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY,
		toStoredTargetKind: toIMessageTargetKind,
		toSessionBindingTargetKind
	});
}
const testing = { resetIMessageConversationBindingsForTests() {
	resetAccountScopedConversationBindingsForTests({ stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY });
} };
//#endregion
export { testing as n, createIMessageConversationBindingManager as t };
