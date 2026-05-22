import { i as OpenClawConfig } from "./types.openclaw-BdSNxnBz.js";
import { c as ReplyPayload, r as GetReplyOptions } from "./get-reply-options.types-B8_lZjMZ.js";
import { n as MsgContext } from "./templating-B2YqU08i.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };