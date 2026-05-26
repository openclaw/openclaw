//#region src/plugin-sdk/tool-send.d.ts
/** Extract the canonical send target fields from tool arguments when the action matches. */
declare function extractToolSend(args: Record<string, unknown>, expectedAction?: string): {
  to: string;
  accountId?: string;
  threadId?: string;
} | null;
//#endregion
export { extractToolSend as t };