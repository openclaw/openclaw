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
function removeAckReactionAfterReply(params) {
	if (!params.removeAfterReply) return;
	if (!params.ackReactionPromise) return;
	if (!params.ackReactionValue) return;
	params.ackReactionPromise.then((didAck) => {
		if (!didAck) return;
		params.remove().catch((err) => params.onError?.(err));
	});
}
//#endregion
export { removeAckReactionAfterReply, shouldAckReaction };
