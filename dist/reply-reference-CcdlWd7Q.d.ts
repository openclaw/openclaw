import { T as ReplyToMode } from "./types.base-DS--yneR.js";
import { i as ReplyThreadingPolicy } from "./get-reply-options.types-DiZecFJG.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };