//#region extensions/feishu/src/session-conversation.d.ts
declare function resolveFeishuSessionConversation(params: {
  kind: "group" | "channel";
  rawId: string;
}): {
  id: string;
  baseConversationId: string;
  parentConversationCandidates: string[];
} | null;
//#endregion
export { resolveFeishuSessionConversation as resolveSessionConversation };