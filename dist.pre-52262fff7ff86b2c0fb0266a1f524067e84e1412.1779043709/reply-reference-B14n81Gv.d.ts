import { T as ReplyToMode } from "./types.base-CLStZQus.js";
import { s as ReplyThreadingPolicy } from "./get-reply-options.types-DKSjR49p.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };