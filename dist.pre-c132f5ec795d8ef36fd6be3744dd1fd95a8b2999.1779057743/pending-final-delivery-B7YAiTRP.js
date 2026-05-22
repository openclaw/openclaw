import { _ as stripInternalMetadataForDisplay } from "./session-utils.fs-CEEDZAwT.js";
import { a as isSilentReplyText, c as stripLeadingSilentToken, l as stripSilentToken, n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, r as isSilentReplyPayloadText } from "./tokens-2q03qiGF.js";
//#region src/auto-reply/reply/pending-final-delivery.ts
function sanitizePendingFinalDeliveryText(text) {
	let stripped = stripInternalMetadataForDisplay(text).trim();
	if (isSilentReplyPayloadText(stripped, "NO_REPLY")) return "";
	if (stripped && !isSilentReplyText(stripped, "NO_REPLY")) {
		const hasLeadingSilentToken = startsWithSilentToken(stripped, SILENT_REPLY_TOKEN);
		if (hasLeadingSilentToken) stripped = stripLeadingSilentToken(stripped, SILENT_REPLY_TOKEN);
		if (hasLeadingSilentToken || stripped.toLowerCase().includes("NO_REPLY".toLowerCase())) stripped = stripSilentToken(stripped, SILENT_REPLY_TOKEN);
	}
	if (!stripped.trim()) return "";
	return isSilentReplyPayloadText(stripped, "NO_REPLY") ? "" : stripped.trim();
}
//#endregion
export { sanitizePendingFinalDeliveryText as t };
