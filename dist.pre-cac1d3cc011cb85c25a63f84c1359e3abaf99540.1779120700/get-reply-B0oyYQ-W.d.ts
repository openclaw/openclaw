import { i as OpenClawConfig } from "./types.openclaw-C58U02FA.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-D7_8PyRX.js";
import { n as MsgContext } from "./templating-CTqAhpks.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };