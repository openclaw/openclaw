//#region extensions/matrix/src/thread-binding-api.d.ts
declare const defaultTopLevelPlacement: "child";
declare function resolveMatrixInboundConversation(params: {
  to?: string;
  conversationId?: string;
  threadId?: string | number;
}): {
  parentConversationId?: string | undefined;
  conversationId: string;
} | null;
//#endregion
export { defaultTopLevelPlacement, resolveMatrixInboundConversation as resolveInboundConversation };