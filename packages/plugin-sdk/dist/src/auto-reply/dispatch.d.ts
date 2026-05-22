import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.types.js";
import type { GetReplyFromConfig } from "./reply/get-reply.types.js";
import { type ReplyDispatcherOptions, type ReplyDispatcherWithTypingOptions } from "./reply/reply-dispatcher.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";
export type DispatchInboundResult = DispatchFromConfigResult;
export { settleReplyDispatcher, withReplyDispatcher } from "./dispatch-dispatcher.js";
export declare function dispatchInboundMessage(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcher: ReplyDispatcher;
    replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
    replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult>;
export declare function dispatchInboundMessageWithBufferedDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherWithTypingOptions;
    replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
    replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult>;
export declare function dispatchInboundMessageWithDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherOptions;
    replyOptions?: Omit<GetReplyOptions, "onBlockReply">;
    replyResolver?: GetReplyFromConfig;
}): Promise<DispatchInboundResult>;
