import { T as ReplyToMode } from "./types.base-DS--yneR.js";
//#region src/auto-reply/reply/reply-reference.d.ts
type ReplyReferencePlanner = {
  /** Returns the effective reply/thread id for the next send without updating state. */peek(): string | undefined; /** Returns the effective reply/thread id for the next send and updates state. */
  use(): string | undefined; /** Mark that a reply was sent (needed when no reference is used). */
  markSent(): void; /** Whether a reply has been sent in this flow. */
  hasReplied(): boolean;
};
declare function isSingleUseReplyToMode(mode: ReplyToMode): boolean;
declare function createReplyReferencePlanner(options: {
  replyToMode: ReplyToMode; /** Existing thread/reference id (preferred when allowed by replyToMode). */
  existingId?: string; /** Id to start a new thread/reference when allowed (e.g., parent message id). */
  startId?: string; /** Disable reply references entirely (e.g., when posting inside a new thread). */
  allowReference?: boolean; /** Seed the planner with prior reply state. */
  hasReplied?: boolean;
}): ReplyReferencePlanner;
//#endregion
export { isSingleUseReplyToMode as n, createReplyReferencePlanner as t };