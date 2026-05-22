import { T as ReplyToMode } from "./types.base-B1xU9TH3.js";
import { s as ReplyThreadingPolicy } from "./get-reply-options.types-Dr32ceD1.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };