//#region src/auto-reply/reply/history.types.d.ts
type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
  media?: HistoryMediaEntry[];
};
type HistoryMediaEntry = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: "image" | "video" | "audio" | "document" | "unknown";
  messageId?: string;
};
//#endregion
export { HistoryMediaEntry as n, HistoryEntry as t };