import type { MessageReceipt } from "../../channels/message/types.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
export type OutboundDeliveryResult = {
    channel: Exclude<ChannelId, "none">;
    messageId: string;
    chatId?: string;
    channelId?: string;
    roomId?: string;
    conversationId?: string;
    timestamp?: number;
    toJid?: string;
    pollId?: string;
    receipt?: MessageReceipt;
    meta?: Record<string, unknown>;
};
export type OutboundPayloadDeliverySuppressionReason = "cancelled_by_message_sending_hook" | "empty_after_message_sending_hook" | "no_visible_payload" | "adapter_returned_no_identity";
export type OutboundDeliveryFailureStage = "platform_send" | "queue" | "unknown";
export type OutboundPayloadDeliveryOutcome = {
    index: number;
    status: "sent";
    results: OutboundDeliveryResult[];
} | {
    index: number;
    status: "suppressed";
    reason: OutboundPayloadDeliverySuppressionReason;
    hookEffect?: {
        cancelReason?: string;
        metadata?: Record<string, unknown>;
    };
} | {
    index: number;
    status: "failed";
    error: unknown;
    sentBeforeError: boolean;
    stage: OutboundDeliveryFailureStage;
};
export declare class OutboundDeliveryError extends Error {
    readonly results: OutboundDeliveryResult[];
    readonly payloadOutcomes: OutboundPayloadDeliveryOutcome[];
    readonly sentBeforeError: boolean;
    readonly stage: OutboundDeliveryFailureStage;
    constructor(message: string, options: {
        cause: unknown;
        results?: readonly OutboundDeliveryResult[];
        payloadOutcomes?: readonly OutboundPayloadDeliveryOutcome[];
        stage?: OutboundDeliveryFailureStage;
    });
}
export declare function isOutboundDeliveryError(error: unknown): error is OutboundDeliveryError;
