import { T as ReplyToMode } from "./types.base-BV0Xx5AM.js";
import { a as ReplyThreadingPolicy } from "./get-reply-options.types-BQuqGiER.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };