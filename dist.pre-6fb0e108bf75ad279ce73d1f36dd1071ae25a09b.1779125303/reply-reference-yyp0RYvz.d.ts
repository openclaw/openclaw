import { T as ReplyToMode } from "./types.base-CzXKYjot.js";
import { s as ReplyThreadingPolicy } from "./get-reply-options.types-C8m6CPQR.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };