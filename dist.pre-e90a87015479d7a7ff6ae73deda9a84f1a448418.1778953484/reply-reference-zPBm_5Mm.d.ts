import { T as ReplyToMode } from "./types.base-CxMBQUJ_.js";
import { a as ReplyThreadingPolicy } from "./get-reply-options.types-CEbMlRdT.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };