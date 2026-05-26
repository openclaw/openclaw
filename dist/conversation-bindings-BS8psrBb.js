import { t as getChannelPlugin } from "./registry-BdfZSqhE2.js";
//#region src/channels/plugins/conversation-bindings.ts
function setChannelConversationBindingIdleTimeoutBySessionKey(params) {
	const setIdleTimeoutBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings?.setIdleTimeoutBySessionKey;
	if (!setIdleTimeoutBySessionKey) return [];
	return setIdleTimeoutBySessionKey({
		targetSessionKey: params.targetSessionKey,
		accountId: params.accountId,
		idleTimeoutMs: params.idleTimeoutMs
	});
}
function setChannelConversationBindingMaxAgeBySessionKey(params) {
	const setMaxAgeBySessionKey = getChannelPlugin(params.channelId)?.conversationBindings?.setMaxAgeBySessionKey;
	if (!setMaxAgeBySessionKey) return [];
	return setMaxAgeBySessionKey({
		targetSessionKey: params.targetSessionKey,
		accountId: params.accountId,
		maxAgeMs: params.maxAgeMs
	});
}
//#endregion
export { setChannelConversationBindingMaxAgeBySessionKey as n, setChannelConversationBindingIdleTimeoutBySessionKey as t };
