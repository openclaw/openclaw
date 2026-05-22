import { i as OpenClawConfig } from "./types.openclaw-BlE9q7jU.js";
import { c as ReplyPayload, r as GetReplyOptions } from "./get-reply-options.types-xkFn9Z_M.js";
import { n as MsgContext } from "./templating-BkJN6_hx.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };