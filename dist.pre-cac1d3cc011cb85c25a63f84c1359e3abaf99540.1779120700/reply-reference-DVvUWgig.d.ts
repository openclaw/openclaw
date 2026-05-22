import { T as ReplyToMode } from "./types.base-Ckc5Vavh.js";
import { s as ReplyThreadingPolicy } from "./get-reply-options.types-D7_8PyRX.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };