import type { OpenClawConfig } from "../config/config.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { type ReplyDispatcher, type ReplyDispatcherOptions, type ReplyDispatcherWithTypingOptions } from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";
export type DispatchInboundResult = DispatchFromConfigResult;
export declare function withReplyDispatcher<T>(params: {
    dispatcher: ReplyDispatcher;
    run: () => Promise<T>;
    onSettled?: () => void | Promise<void>;
}): Promise<T>;
export declare function dispatchInboundMessage(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcher: ReplyDispatcher;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult>;
export declare function dispatchInboundMessageWithBufferedDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherWithTypingOptions;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult>;
export declare function dispatchInboundMessageWithDispatcher(params: {
    ctx: MsgContext | FinalizedMsgContext;
    cfg: OpenClawConfig;
    dispatcherOptions: ReplyDispatcherOptions;
    replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
    replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult>;
