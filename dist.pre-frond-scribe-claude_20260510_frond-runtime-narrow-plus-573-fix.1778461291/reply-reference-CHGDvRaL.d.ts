import { T as ReplyToMode } from "./types.base-CN1BlTRP.js";
import { i as ReplyThreadingPolicy } from "./get-reply-options.types-eDPD5YMs.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };