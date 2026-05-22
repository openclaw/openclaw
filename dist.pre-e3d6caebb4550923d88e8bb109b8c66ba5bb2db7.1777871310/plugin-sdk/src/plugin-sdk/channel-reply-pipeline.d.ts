import type { SourceReplyDeliveryMode } from "../auto-reply/get-reply-options.types.js";
import { type SourceReplyDeliveryModeContext } from "../auto-reply/reply/source-reply-delivery-mode.js";
import { createReplyPrefixContext, createReplyPrefixOptions, type ReplyPrefixContextBundle, type ReplyPrefixOptions } from "../channels/reply-prefix.js";
import { createTypingCallbacks, type CreateTypingCallbacksParams, type TypingCallbacks } from "../channels/typing.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ReplyPayload } from "./reply-payload.js";
export type ReplyPrefixContext = ReplyPrefixContextBundle["prefixContext"];
export type { ReplyPrefixContextBundle, ReplyPrefixOptions };
export type { CreateTypingCallbacksParams, TypingCallbacks };
export { createReplyPrefixContext, createReplyPrefixOptions, createTypingCallbacks };
export type { SourceReplyDeliveryMode };
export declare function resolveChannelSourceReplyDeliveryMode(params: {
    cfg: OpenClawConfig;
    ctx: SourceReplyDeliveryModeContext;
    requested?: SourceReplyDeliveryMode;
    messageToolAvailable?: boolean;
}): SourceReplyDeliveryMode;
export type ChannelReplyPipeline = ReplyPrefixOptions & {
    typingCallbacks?: TypingCallbacks;
    transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};
export declare function createChannelReplyPipeline(params: {
    cfg: Parameters<typeof createReplyPrefixOptions>[0]["cfg"];
    agentId: string;
    channel?: string;
    accountId?: string;
    typing?: CreateTypingCallbacksParams;
    typingCallbacks?: TypingCallbacks;
    transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
}): ChannelReplyPipeline;
