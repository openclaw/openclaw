import type { OpenClawConfig } from "../../config/config.js";
import { type GatewayClientMode, type GatewayClientName } from "../../utils/message-channel.js";
import { type OutboundDeliveryResult, type OutboundSendDeps } from "./deliver.js";
export type MessageGatewayOptions = {
    url?: string;
    token?: string;
    timeoutMs?: number;
    clientName?: GatewayClientName;
    clientDisplayName?: string;
    mode?: GatewayClientMode;
};
type MessageSendParams = {
    to: string;
    content: string;
    /** Active agent id for per-agent outbound media root scoping. */
    agentId?: string;
    channel?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    gifPlayback?: boolean;
    accountId?: string;
    replyToId?: string;
    threadId?: string | number;
    dryRun?: boolean;
    bestEffort?: boolean;
    deps?: OutboundSendDeps;
    cfg?: OpenClawConfig;
    gateway?: MessageGatewayOptions;
    idempotencyKey?: string;
    mirror?: {
        sessionKey: string;
        agentId?: string;
        text?: string;
        mediaUrls?: string[];
    };
    abortSignal?: AbortSignal;
    silent?: boolean;
};
export type MessageSendResult = {
    channel: string;
    to: string;
    via: "direct" | "gateway";
    mediaUrl: string | null;
    mediaUrls?: string[];
    result?: OutboundDeliveryResult | {
        messageId: string;
    };
    dryRun?: boolean;
};
type MessagePollParams = {
    to: string;
    question: string;
    options: string[];
    maxSelections?: number;
    durationSeconds?: number;
    durationHours?: number;
    channel?: string;
    accountId?: string;
    threadId?: string;
    silent?: boolean;
    isAnonymous?: boolean;
    dryRun?: boolean;
    cfg?: OpenClawConfig;
    gateway?: MessageGatewayOptions;
    idempotencyKey?: string;
};
export type MessagePollResult = {
    channel: string;
    to: string;
    question: string;
    options: string[];
    maxSelections: number;
    durationSeconds: number | null;
    durationHours: number | null;
    via: "gateway";
    result?: {
        messageId: string;
        toJid?: string;
        channelId?: string;
        conversationId?: string;
        pollId?: string;
    };
    dryRun?: boolean;
};
export declare function sendMessage(params: MessageSendParams): Promise<MessageSendResult>;
export declare function sendPoll(params: MessagePollParams): Promise<MessagePollResult>;
export {};
