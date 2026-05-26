import { c as buildPendingHistoryContextFromMap, h as recordPendingHistoryEntryWithMedia, m as recordPendingHistoryEntryIfEnabled, s as buildInboundHistoryFromMap, u as clearHistoryEntriesIfEnabled } from "./history-BD_TtuvO.js";
//#region src/channels/turn/history-window.ts
function createChannelHistoryWindow(params) {
	const { historyMap } = params;
	return {
		record: (recordParams) => recordPendingHistoryEntryIfEnabled({
			historyMap,
			historyKey: recordParams.historyKey,
			limit: recordParams.limit,
			entry: recordParams.entry
		}),
		recordWithMedia: (recordParams) => recordPendingHistoryEntryWithMedia({
			historyMap,
			historyKey: recordParams.historyKey,
			limit: recordParams.limit,
			entry: recordParams.entry,
			media: recordParams.media,
			mediaLimit: recordParams.mediaLimit,
			messageId: recordParams.messageId,
			shouldRecord: recordParams.shouldRecord
		}),
		buildPendingContext: (contextParams) => buildPendingHistoryContextFromMap({
			historyMap,
			historyKey: contextParams.historyKey,
			limit: contextParams.limit,
			currentMessage: contextParams.currentMessage,
			formatEntry: contextParams.formatEntry,
			lineBreak: contextParams.lineBreak
		}),
		buildInboundHistory: (historyParams) => buildInboundHistoryFromMap({
			historyMap,
			historyKey: historyParams.historyKey,
			limit: historyParams.limit
		}),
		clear: (clearParams) => clearHistoryEntriesIfEnabled({
			historyMap,
			historyKey: clearParams.historyKey,
			limit: clearParams.limit
		})
	};
}
//#endregion
export { createChannelHistoryWindow as t };
