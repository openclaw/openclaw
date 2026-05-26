import type { ReplyToMode } from "../../config/types.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload, ReplyThreadingPolicy } from "../types.js";
export declare function formatBtwTextForExternalDelivery(payload: ReplyPayload): string | undefined;
export declare function applyReplyTagsToPayload(payload: ReplyPayload, currentMessageId?: string): ReplyPayload;
export declare function isRenderablePayload(payload: ReplyPayload): boolean;
export declare function shouldSuppressReasoningPayload(payload: ReplyPayload): boolean;
export declare function applyReplyThreading(params: {
    payloads: ReplyPayload[];
    replyToMode: ReplyToMode;
    replyToChannel?: OriginatingChannelType;
    currentMessageId?: string;
    replyThreading?: ReplyThreadingPolicy;
}): ReplyPayload[];
