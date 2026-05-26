import { n as extractTextFromChatContent } from "./chat-content-Dc1e9mcQ.js";
import { i as buildHistoryContextFromEntries } from "./history-DVJTezhz.js";
//#region src/gateway/agent-event-assistant-text.ts
function resolveAssistantStreamDeltaText(evt) {
	const delta = evt.data.delta;
	const text = evt.data.text;
	return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}
//#endregion
//#region src/gateway/agent-prompt.ts
/**
* Coerce body to string. Handles cases where body is a content array
* (e.g. [{type:"text", text:"hello"}]) that would serialize as
* [object Object] if used directly in a template literal.
*/
function safeBody(body) {
	if (typeof body === "string") return body;
	return extractTextFromChatContent(body) ?? "";
}
function buildAgentMessageFromConversationEntries(entries) {
	if (entries.length === 0) return "";
	let currentIndex = -1;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const role = entries[i]?.role;
		if (role === "user" || role === "tool") {
			currentIndex = i;
			break;
		}
	}
	if (currentIndex < 0) currentIndex = entries.length - 1;
	const currentEntry = entries[currentIndex]?.entry;
	if (!currentEntry) return "";
	const historyEntries = entries.slice(0, currentIndex).map((e) => e.entry);
	if (historyEntries.length === 0) return safeBody(currentEntry.body);
	const formatEntry = (entry) => `${entry.sender}: ${safeBody(entry.body)}`;
	return buildHistoryContextFromEntries({
		entries: [...historyEntries, currentEntry],
		currentMessage: formatEntry(currentEntry),
		formatEntry
	});
}
//#endregion
//#region src/gateway/input-allowlist.ts
/**
* Normalize optional gateway URL-input hostname allowlists.
*
* Semantics are intentionally:
* - missing / empty / whitespace-only list => no hostname allowlist restriction
* - deny-all URL fetching => use the corresponding `allowUrl: false` switch
*/
function normalizeInputHostnameAllowlist(values) {
	if (!values || values.length === 0) return;
	const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
	return normalized.length > 0 ? normalized : void 0;
}
//#endregion
export { buildAgentMessageFromConversationEntries as n, resolveAssistantStreamDeltaText as r, normalizeInputHostnameAllowlist as t };
