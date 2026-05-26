import { o as resolveAssistantEventPhase } from "./chat-message-content-DN9xEd6w.js";
import { u as stripInternalRuntimeContext } from "./internal-runtime-context-DWxvZFcB.js";
import { n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, s as stripLeadingSilentToken } from "./tokens-CFv3Qu_v.js";
import { i as stripInlineDirectiveTagsForDisplay } from "./directive-tags-CClLEtM7.js";
import { n as isSuppressedControlReplyText, t as isSuppressedControlReplyLeadFragment } from "./control-reply-text-CL8TBl4o.js";
function capLiveAssistantBuffer(text) {
	if (text.length <= 5e5) return text;
	return text.slice(-5e5);
}
function resolveMergedAssistantText(params) {
	const { previousText, nextText, nextDelta } = params;
	if (nextText && previousText) {
		if (nextText.startsWith(previousText) && nextText.length > previousText.length) return capLiveAssistantBuffer(nextText);
		if (previousText.startsWith(nextText) && !nextDelta) return capLiveAssistantBuffer(previousText);
	}
	if (nextDelta) return capLiveAssistantBuffer(previousText + nextDelta);
	if (nextText) return capLiveAssistantBuffer(nextText);
	return capLiveAssistantBuffer(previousText);
}
function normalizeLiveAssistantEventText(params) {
	return {
		text: stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(params.text).text),
		delta: typeof params.delta === "string" ? stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(params.delta).text) : ""
	};
}
function projectLiveAssistantBufferedText(rawText, options) {
	if (!rawText) return {
		text: "",
		suppress: true,
		pendingLeadFragment: false
	};
	if (isSuppressedControlReplyText(rawText)) return {
		text: "",
		suppress: true,
		pendingLeadFragment: false
	};
	if (options?.suppressLeadFragments !== false && isSuppressedControlReplyLeadFragment(rawText)) return {
		text: rawText,
		suppress: true,
		pendingLeadFragment: true
	};
	const text = startsWithSilentToken(rawText, "NO_REPLY") ? stripLeadingSilentToken(rawText, SILENT_REPLY_TOKEN) : rawText;
	if (!text || isSuppressedControlReplyText(text)) return {
		text: "",
		suppress: true,
		pendingLeadFragment: false
	};
	if (options?.suppressLeadFragments !== false && isSuppressedControlReplyLeadFragment(text)) return {
		text,
		suppress: true,
		pendingLeadFragment: true
	};
	return {
		text,
		suppress: false,
		pendingLeadFragment: false
	};
}
function shouldSuppressAssistantEventForLiveChat(data) {
	return resolveAssistantEventPhase(data) === "commentary";
}
//#endregion
export { shouldSuppressAssistantEventForLiveChat as i, projectLiveAssistantBufferedText as n, resolveMergedAssistantText as r, normalizeLiveAssistantEventText as t };
