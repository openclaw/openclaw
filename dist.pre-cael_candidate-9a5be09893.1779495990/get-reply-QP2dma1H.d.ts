import { i as OpenClawConfig } from "./types.openclaw-GamulG8g.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-BbifzHXd.js";
import { n as MsgContext } from "./templating-C1EVuBnx.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };