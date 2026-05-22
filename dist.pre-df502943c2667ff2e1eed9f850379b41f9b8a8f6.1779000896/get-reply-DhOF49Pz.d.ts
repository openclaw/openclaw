import { i as OpenClawConfig } from "./types.openclaw-D8bJSZjd.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-12YQxlfc.js";
import { n as MsgContext } from "./templating-ZB-72phm.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };