import { T as ReplyToMode } from "./types.base-DugutrX1.js";
import { a as ReplyThreadingPolicy } from "./get-reply-options.types-B8_lZjMZ.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };