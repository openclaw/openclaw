import { i as OpenClawConfig } from "./types.openclaw-BorXMoYB.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-BLTPrIkz.js";
import { n as MsgContext } from "./templating-B_g0gfQr.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };