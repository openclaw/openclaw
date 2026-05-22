import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-Dr32ceD1.js";
import { n as MsgContext } from "./templating-CLzigwF3.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };