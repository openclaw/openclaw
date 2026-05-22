import { i as OpenClawConfig } from "./types.openclaw-Cy0U3Gwh.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-BbifzHXd.js";
import { n as MsgContext } from "./templating-C-WZP00b.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };