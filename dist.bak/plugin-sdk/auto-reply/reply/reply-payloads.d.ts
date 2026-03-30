import type { MessagingToolSend } from "../../agents/pi-embedded-runner.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
export declare function applyReplyTagsToPayload(payload: ReplyPayload, currentMessageId?: string): ReplyPayload;
export declare function isRenderablePayload(payload: ReplyPayload): boolean;
export declare function shouldSuppressReasoningPayload(payload: ReplyPayload): boolean;
export declare function applyReplyThreading(params: {
    payloads: ReplyPayload[];
    replyToMode: ReplyToMode;
    replyToChannel?: OriginatingChannelType;
    currentMessageId?: string;
}): ReplyPayload[];
export declare function filterMessagingToolDuplicates(params: {
    payloads: ReplyPayload[];
    sentTexts: string[];
}): ReplyPayload[];
export declare function filterMessagingToolMediaDuplicates(params: {
    payloads: ReplyPayload[];
    sentMediaUrls: string[];
}): ReplyPayload[];
export declare function shouldSuppressMessagingToolReplies(params: {
    messageProvider?: string;
    messagingToolSentTargets?: MessagingToolSend[];
    originatingTo?: string;
    accountId?: string;
}): boolean;
