import { t as CURRENT_MESSAGE_MARKER } from "./mentions-DmNrCnsQ.js";
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
/**
* @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).record(...)`.
* This helper remains for core internals and older plugin compatibility.
*/
function recordPendingHistoryEntry(params) {
	return appendHistoryEntry(params);
}
/**
* @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).record(...)`.
* This helper remains for core internals and older plugin compatibility.
*/
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
const DEFAULT_HISTORY_MEDIA_LIMIT = 4;
function isLocalHistoryMediaPath(path) {
	if (/^[a-z]:[\\/]/i.test(path)) return true;
	return !/^[a-z][a-z0-9+.-]*:/i.test(path);
}
function isImageHistoryMediaEntry(entry) {
	const contentType = entry.contentType?.split(";")[0]?.trim().toLowerCase();
	return entry.kind === "image" || contentType?.startsWith("image/") === true;
}
function normalizeHistoryMediaEntries(params) {
	const limit = Math.max(0, params.limit ?? DEFAULT_HISTORY_MEDIA_LIMIT);
	if (limit <= 0 || !params.media?.length) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of params.media) {
		if (!isImageHistoryMediaEntry(entry)) continue;
		const path = entry.path?.trim();
		if (!path || !isLocalHistoryMediaPath(path)) continue;
		const dedupeKey = `${entry.messageId ?? params.messageId ?? ""}\0${path}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		out.push({
			path,
			contentType: entry.contentType,
			kind: "image",
			messageId: entry.messageId ?? params.messageId
		});
		if (out.length >= limit) break;
	}
	return out;
}
/**
* @deprecated Plugin message-turn code should use
* `createChannelHistoryWindow(...).recordWithMedia(...)`. This helper remains
* for core internals and older plugin compatibility.
*/
async function recordPendingHistoryEntryWithMedia(params) {
	if (!params.entry || params.limit <= 0) return [];
	if (params.shouldRecord && !params.shouldRecord()) return [];
	if (typeof params.media === "function") {
		const recordedEntry = params.entry;
		const history = recordPendingHistoryEntry({
			historyMap: params.historyMap,
			historyKey: params.historyKey,
			entry: recordedEntry,
			limit: params.limit
		});
		const resolvedMedia = await params.media();
		if (params.shouldRecord && !params.shouldRecord()) return history;
		const media = normalizeHistoryMediaEntries({
			media: resolvedMedia,
			limit: params.mediaLimit,
			messageId: params.messageId ?? params.entry.messageId
		});
		if (media.length === 0) return history;
		const currentHistory = params.historyMap.get(params.historyKey);
		const entryIndex = currentHistory?.indexOf(recordedEntry) ?? -1;
		if (currentHistory && entryIndex >= 0) currentHistory[entryIndex] = {
			...recordedEntry,
			media
		};
		return history;
	}
	const resolvedMedia = params.media ?? void 0;
	if (params.shouldRecord && !params.shouldRecord()) return [];
	const media = normalizeHistoryMediaEntries({
		media: resolvedMedia,
		limit: params.mediaLimit,
		messageId: params.messageId ?? params.entry.messageId
	});
	const entry = media.length > 0 ? {
		...params.entry,
		media
	} : params.entry;
	return recordPendingHistoryEntry({
		historyMap: params.historyMap,
		historyKey: params.historyKey,
		entry,
		limit: params.limit
	});
}
/**
* @deprecated Plugin message-turn code should use
* `createChannelHistoryWindow(...).buildPendingContext(...)`. This helper remains
* for core internals and older plugin compatibility.
*/
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
/**
* @deprecated Plugin message-turn code should use
* `createChannelHistoryWindow(...).buildInboundHistory(...)`. This helper remains
* for core internals and older plugin compatibility.
*/
function buildInboundHistoryFromMap(params) {
	return buildInboundHistoryFromEntries({
		entries: params.historyMap.get(params.historyKey) ?? [],
		limit: params.limit
	});
}
function buildInboundHistoryFromEntries(params) {
	if (params.limit <= 0) return;
	if (params.entries.length === 0) return [];
	return params.entries.slice(-params.limit).map((entry) => {
		const historyEntry = {
			sender: entry.sender,
			body: entry.body,
			timestamp: entry.timestamp
		};
		if (entry.messageId) historyEntry.messageId = entry.messageId;
		if (entry.media && entry.media.length > 0) historyEntry.media = entry.media;
		return historyEntry;
	});
}
/**
* @deprecated Prefer `buildHistoryContextFromEntries(...)` for existing entry
* arrays, or `createChannelHistoryWindow(...)` when working from a history map.
* This helper remains for older plugin compatibility.
*/
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
/**
* @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).clear(...)`.
* This helper remains for core internals and older plugin compatibility.
*/
function clearHistoryEntries(params) {
	params.historyMap.set(params.historyKey, []);
}
/**
* @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).clear(...)`.
* This helper remains for core internals and older plugin compatibility.
*/
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
export { buildHistoryContextFromMap as a, buildPendingHistoryContextFromMap as c, evictOldHistoryKeys as d, normalizeHistoryMediaEntries as f, recordPendingHistoryEntryWithMedia as h, buildHistoryContextFromEntries as i, clearHistoryEntries as l, recordPendingHistoryEntryIfEnabled as m, HISTORY_CONTEXT_MARKER as n, buildInboundHistoryFromEntries as o, recordPendingHistoryEntry as p, buildHistoryContext as r, buildInboundHistoryFromMap as s, DEFAULT_GROUP_HISTORY_LIMIT as t, clearHistoryEntriesIfEnabled as u };
