import { t as CURRENT_MESSAGE_MARKER } from "./mentions-C1aKJ5EP.js";
//#region src/auto-reply/reply/history.ts
const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
const DEFAULT_GROUP_HISTORY_LIMIT = 50;
/** Maximum number of group history keys to retain (LRU eviction when exceeded). */
const MAX_HISTORY_KEYS = 1e3;
/**
* Evict oldest keys from a history map when it exceeds MAX_HISTORY_KEYS.
* Uses Map's insertion order for LRU-like behavior.
*/
function evictOldHistoryKeys(historyMap, maxKeys = MAX_HISTORY_KEYS) {
	if (historyMap.size <= maxKeys) return;
	const keysToDelete = historyMap.size - maxKeys;
	const iterator = historyMap.keys();
	for (let i = 0; i < keysToDelete; i++) {
		const key = iterator.next().value;
		if (key !== void 0) historyMap.delete(key);
	}
}
function buildHistoryContext(params) {
	const { historyText, currentMessage } = params;
	const lineBreak = params.lineBreak ?? "\n";
	if (!historyText.trim()) return currentMessage;
	return [
		HISTORY_CONTEXT_MARKER,
		historyText,
		"",
		CURRENT_MESSAGE_MARKER,
		currentMessage
	].join(lineBreak);
}
function appendHistoryEntry(params) {
	const { historyMap, historyKey, entry } = params;
	if (params.limit <= 0) return [];
	const history = historyMap.get(historyKey) ?? [];
	history.push(entry);
	const overflowCount = history.length - params.limit;
	if (overflowCount > 0) history.splice(0, overflowCount);
	if (historyMap.has(historyKey)) historyMap.delete(historyKey);
	historyMap.set(historyKey, history);
	evictOldHistoryKeys(historyMap);
	return history;
}
function recordPendingHistoryEntry(params) {
	return appendHistoryEntry(params);
}
function recordPendingHistoryEntryIfEnabled(params) {
	if (!params.entry) return [];
	if (params.limit <= 0) return [];
	return recordPendingHistoryEntry({
		historyMap: params.historyMap,
		historyKey: params.historyKey,
		entry: params.entry,
		limit: params.limit
	});
}
function buildPendingHistoryContextFromMap(params) {
	if (params.limit <= 0) return params.currentMessage;
	return buildHistoryContextFromEntries({
		entries: params.historyMap.get(params.historyKey) ?? [],
		currentMessage: params.currentMessage,
		formatEntry: params.formatEntry,
		lineBreak: params.lineBreak,
		excludeLast: false
	});
}
function buildHistoryContextFromMap(params) {
	if (params.limit <= 0) return params.currentMessage;
	return buildHistoryContextFromEntries({
		entries: params.entry ? appendHistoryEntry({
			historyMap: params.historyMap,
			historyKey: params.historyKey,
			entry: params.entry,
			limit: params.limit
		}) : params.historyMap.get(params.historyKey) ?? [],
		currentMessage: params.currentMessage,
		formatEntry: params.formatEntry,
		lineBreak: params.lineBreak,
		excludeLast: params.excludeLast
	});
}
function clearHistoryEntries(params) {
	params.historyMap.set(params.historyKey, []);
}
function clearHistoryEntriesIfEnabled(params) {
	if (params.limit <= 0) return;
	clearHistoryEntries({
		historyMap: params.historyMap,
		historyKey: params.historyKey
	});
}
function buildHistoryContextFromEntries(params) {
	const lineBreak = params.lineBreak ?? "\n";
	const entries = params.excludeLast === false ? params.entries : params.entries.slice(0, -1);
	if (entries.length === 0) return params.currentMessage;
	return buildHistoryContext({
		historyText: entries.map(params.formatEntry).join(lineBreak),
		currentMessage: params.currentMessage,
		lineBreak
	});
}
//#endregion
export { buildHistoryContextFromMap as a, clearHistoryEntriesIfEnabled as c, recordPendingHistoryEntryIfEnabled as d, buildHistoryContextFromEntries as i, evictOldHistoryKeys as l, HISTORY_CONTEXT_MARKER as n, buildPendingHistoryContextFromMap as o, buildHistoryContext as r, clearHistoryEntries as s, DEFAULT_GROUP_HISTORY_LIMIT as t, recordPendingHistoryEntry as u };
