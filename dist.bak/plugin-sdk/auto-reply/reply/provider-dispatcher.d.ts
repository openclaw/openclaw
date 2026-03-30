import type { OpenClawConfig } from "../../config/config.js";
import type { DispatchInboundResult } from "../dispatch.js";
import type { FinalizedMsgContext, MsgContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { ReplyDispatcherOptions, ReplyDispatcherWithTypingOptions } from "./reply-dispatcher.js";
export declare function dispatchReplyWithBufferedBlockDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherWithTypingOptions;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof import("../reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult>;
export declare function dispatchReplyWithDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherOptions;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof import("../reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult>;
