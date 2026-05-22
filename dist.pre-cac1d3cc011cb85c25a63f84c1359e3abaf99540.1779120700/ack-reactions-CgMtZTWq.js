//#region src/channels/ack-reactions.ts
function shouldAckReaction(params) {
	const scope = params.scope ?? "group-mentions";
	if (scope === "off" || scope === "none") return false;
	if (scope === "all") return true;
	if (scope === "direct") return params.isDirect;
	if (scope === "group-all") return params.isGroup;
	if (scope === "group-mentions") {
		if (!params.isMentionableGroup) return false;
		if (!params.requireMention) return false;
		if (!params.canDetectMention) return false;
		return params.effectiveWasMentioned || params.shouldBypassMention === true;
	}
	return false;
}
function shouldAckReactionForWhatsApp(params) {
	if (!params.emoji) return false;
	if (params.isDirect) return params.directEnabled;
	if (!params.isGroup) return false;
	if (params.groupMode === "never") return false;
	if (params.groupMode === "always") return true;
	return shouldAckReaction({
		scope: "group-mentions",
		isDirect: false,
		isGroup: true,
		isMentionableGroup: true,
		requireMention: true,
		canDetectMention: true,
		effectiveWasMentioned: params.wasMentioned,
		shouldBypassMention: params.groupActivated
	});
}
function createAckReactionHandle(params) {
	const ackReactionValue = params.ackReactionValue.trim();
	if (!ackReactionValue) return null;
	let sendPromise;
	try {
		sendPromise = params.send();
	} catch (err) {
		sendPromise = Promise.reject(err);
	}
	return {
		ackReactionPromise: sendPromise.then(() => true, (err) => {
			params.onSendError?.(err);
			return false;
		}),
		ackReactionValue,
		remove: params.remove
	};
}
function removeAckReactionAfterReply(params) {
	if (!params.removeAfterReply) return;
	if (!params.ackReactionPromise) return;
	if (!params.ackReactionValue) return;
	params.ackReactionPromise.then((didAck) => {
		if (!didAck) return;
		params.remove().catch((err) => params.onError?.(err));
	});
}
function removeAckReactionHandleAfterReply(params) {
	removeAckReactionAfterReply({
		removeAfterReply: params.removeAfterReply,
		ackReactionPromise: params.ackReaction?.ackReactionPromise ?? null,
		ackReactionValue: params.ackReaction?.ackReactionValue ?? null,
		remove: params.ackReaction?.remove ?? (async () => {}),
		onError: params.onError
	});
}
//#endregion
export { shouldAckReactionForWhatsApp as a, shouldAckReaction as i, removeAckReactionAfterReply as n, removeAckReactionHandleAfterReply as r, createAckReactionHandle as t };
