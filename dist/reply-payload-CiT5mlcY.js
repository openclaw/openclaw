//#region src/auto-reply/reply-payload.ts
const REPLY_MEDIA_FAILURE_WARNING = "⚠️ Media failed.";
function appendReplyMediaFailureWarning(text) {
	if (!text?.trim()) return REPLY_MEDIA_FAILURE_WARNING;
	if (text.includes("⚠️ Media failed.")) return text;
	return `${text}\n${REPLY_MEDIA_FAILURE_WARNING}`;
}
function normalizeTtsSupplementSpokenText(value) {
	return typeof value === "string" && value.trim() ? value : void 0;
}
function hasReplyPayloadMedia(payload) {
	return Boolean(payload.mediaUrl?.trim() || payload.mediaUrls?.some((url) => url.trim()));
}
function getReplyPayloadTtsSupplement(payload) {
	const spokenText = normalizeTtsSupplementSpokenText(payload.ttsSupplement?.spokenText);
	if (!spokenText || !hasReplyPayloadMedia(payload)) return;
	return {
		spokenText,
		...payload.ttsSupplement?.visibleTextAlreadyDelivered === true ? { visibleTextAlreadyDelivered: true } : {}
	};
}
function isReplyPayloadTtsSupplement(payload) {
	return Boolean(getReplyPayloadTtsSupplement(payload));
}
function markReplyPayloadAsTtsSupplement(payload, spokenText = payload.spokenText ?? payload.text ?? "", options) {
	const normalizedSpokenText = normalizeTtsSupplementSpokenText(spokenText);
	if (!normalizedSpokenText) return payload;
	return {
		...payload,
		spokenText: normalizedSpokenText,
		ttsSupplement: {
			spokenText: normalizedSpokenText,
			...options?.visibleTextAlreadyDelivered === true ? { visibleTextAlreadyDelivered: true } : {}
		}
	};
}
function buildTtsSupplementMediaPayload(payload) {
	const supplement = getReplyPayloadTtsSupplement(payload);
	if (!supplement) return payload;
	const { text: _text, presentation: _presentation, interactive: _interactive, btw: _btw, ...mediaPayload } = payload;
	return {
		...mediaPayload,
		spokenText: supplement.spokenText,
		ttsSupplement: supplement
	};
}
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
function isReplyPayloadStatusNotice(payload) {
	return Boolean(payload.isCompactionNotice || payload.isFallbackNotice || payload.isStatusNotice);
}
//#endregion
export { getReplyPayloadTtsSupplement as a, markReplyPayloadAsTtsSupplement as c, getReplyPayloadMetadata as i, markReplyPayloadForSourceSuppressionDelivery as l, buildTtsSupplementMediaPayload as n, isReplyPayloadStatusNotice as o, copyReplyPayloadMetadata as r, isReplyPayloadTtsSupplement as s, appendReplyMediaFailureWarning as t, setReplyPayloadMetadata as u };
