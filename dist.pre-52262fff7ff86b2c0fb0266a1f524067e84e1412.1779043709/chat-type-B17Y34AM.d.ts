//#region src/channels/chat-type.d.ts
type ChatType = "direct" | "group" | "channel";
declare function normalizeChatType(raw?: string): ChatType | undefined;
//#endregion
export { normalizeChatType as n, ChatType as t };