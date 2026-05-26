import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as GetReplyOptions, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };