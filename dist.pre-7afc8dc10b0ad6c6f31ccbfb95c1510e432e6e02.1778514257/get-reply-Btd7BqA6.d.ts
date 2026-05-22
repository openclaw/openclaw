import { i as OpenClawConfig } from "./types.openclaw-C9E_zZnO.js";
import { c as ReplyPayload, r as GetReplyOptions } from "./get-reply-options.types-BQuqGiER.js";
import { n as MsgContext } from "./templating-DzQjcfk9.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };