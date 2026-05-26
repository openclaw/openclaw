import { n as resetAccountScopedConversationBindingsForTests, t as createAccountScopedConversationBindingManager } from "./thread-bindings-runtime-De-a_T3T.js";
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
const __testing = { resetIMessageConversationBindingsForTests() {
	resetAccountScopedConversationBindingsForTests({ stateKey: IMESSAGE_CONVERSATION_BINDINGS_STATE_KEY });
} };
//#endregion
export { createIMessageConversationBindingManager as n, __testing as t };
