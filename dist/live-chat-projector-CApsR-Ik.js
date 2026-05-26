import { o as resolveAssistantEventPhase } from "./chat-message-content-Df8A1xtk.js";
import { u as stripInternalRuntimeContext } from "./internal-runtime-context-BfEj0QEU.js";
import { n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, s as stripLeadingSilentToken } from "./tokens-CUA96vf1.js";
import { i as stripInlineDirectiveTagsForDisplay } from "./directive-tags-BJVNV8sk.js";
import { n as isSuppressedControlReplyText, t as isSuppressedControlReplyLeadFragment } from "./control-reply-text-CmzSiDP9.js";
//#region src/gateway/live-chat-projector.ts
const MAX_LIVE_CHAT_BUFFER_CHARS = 5e5;
function capLiveAssistantBuffer(text) {
	if (text.length <= 5e5) return text;
	return text.slice(-MAX_LIVE_CHAT_BUFFER_CHARS);
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
