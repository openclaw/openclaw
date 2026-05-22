import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
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
//#endregion
//#region src/auto-reply/reply/reply-reference.ts
function isSingleUseReplyToMode(mode) {
	return mode === "first" || mode === "batched";
}
function createReplyReferencePlanner(options) {
	let hasReplied = options.hasReplied ?? false;
	const allowReference = options.allowReference !== false;
	const existingId = normalizeOptionalString(options.existingId);
	const startId = normalizeOptionalString(options.startId);
	const resolve = () => {
		if (!allowReference) return;
		if (options.replyToMode === "off") return;
		const id = existingId ?? startId;
		if (!id) return;
		if (options.replyToMode === "all") return id;
		if (isSingleUseReplyToMode(options.replyToMode) && hasReplied) return;
		return id;
	};
	const use = () => {
		const id = resolve();
		if (!id) return;
		hasReplied = true;
		return id;
	};
	const markSent = () => {
		hasReplied = true;
	};
	return {
		peek: resolve,
		use,
		markSent,
		hasReplied: () => hasReplied
	};
}
//#endregion
export { copyReplyPayloadMetadata as a, isReplyPayloadTtsSupplement as c, setReplyPayloadMetadata as d, buildTtsSupplementMediaPayload as i, markReplyPayloadAsTtsSupplement as l, isSingleUseReplyToMode as n, getReplyPayloadMetadata as o, appendReplyMediaFailureWarning as r, getReplyPayloadTtsSupplement as s, createReplyReferencePlanner as t, markReplyPayloadForSourceSuppressionDelivery as u };
