import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
export declare function settleReplyDispatcher(params: {
    dispatcher: ReplyDispatcher;
    onSettled?: () => void | Promise<void>;
}): Promise<void>;
export declare function withReplyDispatcher<T>(params: {
    dispatcher: ReplyDispatcher;
    run: () => Promise<T>;
    onSettled?: () => void | Promise<void>;
}): Promise<T>;
