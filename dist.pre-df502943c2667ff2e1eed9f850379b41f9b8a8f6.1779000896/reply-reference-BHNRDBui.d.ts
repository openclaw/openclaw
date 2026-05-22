import { T as ReplyToMode } from "./types.base-YD5s4YZy.js";
import { s as ReplyThreadingPolicy } from "./get-reply-options.types-12YQxlfc.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };