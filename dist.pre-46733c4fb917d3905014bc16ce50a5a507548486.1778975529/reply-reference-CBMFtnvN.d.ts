import { T as ReplyToMode } from "./types.base-18TT18fa.js";
import { s as ReplyThreadingPolicy } from "./get-reply-options.types-CGgi3jrA.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };