//#region src/auto-reply/reply-payload.ts
const replyPayloadMetadata = /* @__PURE__ */ new WeakMap();
function setReplyPayloadMetadata(payload, metadata) {
	const previous = replyPayloadMetadata.get(payload);
	replyPayloadMetadata.set(payload, {
		...previous,
		...metadata
	});
	return payload;
}
function getReplyPayloadMetadata(payload) {
	return replyPayloadMetadata.get(payload);
}
function copyReplyPayloadMetadata(source, payload) {
	const metadata = getReplyPayloadMetadata(source);
	return metadata ? setReplyPayloadMetadata(payload, metadata) : payload;
}
function markReplyPayloadForSourceSuppressionDelivery(payload) {
	return setReplyPayloadMetadata(payload, { deliverDespiteSourceReplySuppression: true });
}
//#endregion
export { setReplyPayloadMetadata as i, getReplyPayloadMetadata as n, markReplyPayloadForSourceSuppressionDelivery as r, copyReplyPayloadMetadata as t };
