import { i as OpenClawConfig } from "./types.openclaw-C5VNg6h3.js";
import { r as GetReplyOptions, u as ReplyPayload } from "./get-reply-options.types-CGgi3jrA.js";
import { n as MsgContext } from "./templating-N7RIHe0-.js";

//#region src/auto-reply/reply/get-reply.d.ts
declare function getReplyFromConfig(ctx: MsgContext, opts?: GetReplyOptions, configOverride?: OpenClawConfig): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { getReplyFromConfig as t };