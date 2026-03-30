import type { OpenClawConfig } from "../../config/config.js";
import { getReplyFromConfig } from "../reply.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { ReplyDispatcher, ReplyDispatchKind } from "./reply-dispatcher.js";
export type DispatchFromConfigResult = {
    queuedFinal: boolean;
    counts: Record<ReplyDispatchKind, number>;
};
export declare function dispatchReplyFromConfig(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcher: ReplyDispatcher;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof getReplyFromConfig;
}): Promise<DispatchFromConfigResult>;
