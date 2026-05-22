import { T as ReplyToMode } from "./types.base-BSU34aN9.js";
import { s as ReplyThreadingPolicy } from "./get-reply-options.types-CZWYz0UM.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };