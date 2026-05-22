//#region extensions/telegram/src/session-conversation.d.ts
declare function resolveTelegramSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}): {
  id: string;
  threadId: string;
  baseConversationId: string;
  parentConversationCandidates: string[];
} | null;
//#endregion
export { resolveTelegramSessionConversation as resolveSessionConversation };