import { i as OpenClawConfig } from "./types.openclaw-DBDmmaVM.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-C8m6CPQR.js";
import { n as MsgContext } from "./templating-CMZ2Oqjr.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };