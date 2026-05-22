import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-DKSjR49p.js";
import { n as MsgContext } from "./templating-COksQNte.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };