import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { r as GetReplyOptions, s as ReplyPayload } from "./get-reply-options.types-eDPD5YMs.js";
import { n as MsgContext } from "./templating-DxY-klDK.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };