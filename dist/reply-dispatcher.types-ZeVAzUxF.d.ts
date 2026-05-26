import { s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
//#region src/auto-reply/reply/reply-dispatcher.types.d.ts
type ReplyDispatchKind = "tool" | "block" | "final";
type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
};
//#endregion
export { ReplyDispatcher as n, ReplyDispatchKind as t };