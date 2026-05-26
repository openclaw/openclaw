import { T as ReplyToMode } from "./types.base-DCoxbfrn.js";
import { i as ReplyThreadingPolicy } from "./get-reply-options.types-BalBo_kk.js";
//#region src/auto-reply/reply/reply-threading.d.ts
declare function resolveBatchedReplyThreadingPolicy(mode: ReplyToMode, isBatched: boolean): ReplyThreadingPolicy | undefined;
//#endregion
export { resolveBatchedReplyThreadingPolicy as t };