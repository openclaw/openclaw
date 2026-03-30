import type { TypingCallbacks } from "../../channels/typing.js";
import type { HumanDelayConfig } from "../../config/types.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { type NormalizeReplySkipReason } from "./normalize-reply.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
export type ReplyDispatchKind = "tool" | "block" | "final";
type ReplyDispatchErrorHandler = (err: unknown, info: {
    kind: ReplyDispatchKind;
}) => void;
type ReplyDispatchSkipHandler = (payload: ReplyPayload, info: {
    kind: ReplyDispatchKind;
    reason: NormalizeReplySkipReason;
}) => void;
type ReplyDispatchDeliverer = (payload: ReplyPayload, info: {
    kind: ReplyDispatchKind;
}) => Promise<void>;
export type ReplyDispatcherOptions = {
    deliver: ReplyDispatchDeliverer;
    responsePrefix?: string;
    /** Static context for response prefix template interpolation. */
    responsePrefixContext?: ResponsePrefixContext;
    /** Dynamic context provider for response prefix template interpolation.
     * Called at normalization time, after model selection is complete. */
    responsePrefixContextProvider?: () => ResponsePrefixContext;
    onHeartbeatStrip?: () => void;
    onIdle?: () => void;
    onError?: ReplyDispatchErrorHandler;
    onSkip?: ReplyDispatchSkipHandler;
    /** Human-like delay between block replies for natural rhythm. */
    humanDelay?: HumanDelayConfig;
};
export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
    typingCallbacks?: TypingCallbacks;
    onReplyStart?: () => Promise<void> | void;
    onIdle?: () => void;
    /** Called when the typing controller is cleaned up (e.g., on NO_REPLY). */
    onCleanup?: () => void;
};
type ReplyDispatcherWithTypingResult = {
    dispatcher: ReplyDispatcher;
    replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController" | "onTypingCleanup">;
    markDispatchIdle: () => void;
};
export type ReplyDispatcher = {
    sendToolResult: (payload: ReplyPayload) => boolean;
    sendBlockReply: (payload: ReplyPayload) => boolean;
    sendFinalReply: (payload: ReplyPayload) => boolean;
    waitForIdle: () => Promise<void>;
    getQueuedCounts: () => Record<ReplyDispatchKind, number>;
    markComplete: () => void;
};
export declare function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher;
export declare function createReplyDispatcherWithTyping(options: ReplyDispatcherWithTypingOptions): ReplyDispatcherWithTypingResult;
export {};
