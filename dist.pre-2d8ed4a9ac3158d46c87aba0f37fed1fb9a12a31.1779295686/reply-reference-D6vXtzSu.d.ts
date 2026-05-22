import { T as ReplyToMode } from "./types.base-CQ4VM2EL.js";
import { s as ReplyThreadingPolicy } from "./get-reply-options.types-Bk9LuA2v.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };