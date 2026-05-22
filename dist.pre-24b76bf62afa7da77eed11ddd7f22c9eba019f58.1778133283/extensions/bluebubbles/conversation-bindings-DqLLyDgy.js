import { n as resetAccountScopedConversationBindingsForTests, t as createAccountScopedConversationBindingManager } from "../../thread-bindings-runtime-DdDXrNQy.js";
//#region extensions/bluebubbles/src/conversation-bindings.ts
const BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY = Symbol.for("openclaw.bluebubblesConversationBindingsState");
function toSessionBindingTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "session";
}
function toBlueBubblesTargetKind(raw) {
	return raw === "subagent" ? "subagent" : "acp";
}
function createBlueBubblesConversationBindingManager(params) {
	return createAccountScopedConversationBindingManager({
		channel: "bluebubbles",
		cfg: params.cfg,
		accountId: params.accountId,
		stateKey: BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY,
		toStoredTargetKind: toBlueBubblesTargetKind,
		toSessionBindingTargetKind
	});
}
const __testing = { resetBlueBubblesConversationBindingsForTests() {
	resetAccountScopedConversationBindingsForTests({ stateKey: BLUEBUBBLES_CONVERSATION_BINDINGS_STATE_KEY });
} };
//#endregion
export { createBlueBubblesConversationBindingManager as n, __testing as t };
