import { i as OpenClawConfig } from "./types.openclaw-BuKAF4PW.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-DJsrtcW0.js";
import { n as MsgContext } from "./templating-BKUxbw7m.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };