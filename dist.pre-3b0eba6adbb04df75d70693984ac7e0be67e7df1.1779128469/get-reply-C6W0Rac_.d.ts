import { i as OpenClawConfig } from "./types.openclaw-DZQrhn8E.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-C9Ngv65K.js";
import { n as MsgContext } from "./templating-DWddnfaD.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };