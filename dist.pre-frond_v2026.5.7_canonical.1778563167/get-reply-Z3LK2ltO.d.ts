import { i as OpenClawConfig } from "./types.openclaw-BdZr8Ncl.js";
import { c as ReplyPayload, r as GetReplyOptions } from "./get-reply-options.types-DJuvZnYu.js";
import { n as MsgContext } from "./templating-BqjyP_SC.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };