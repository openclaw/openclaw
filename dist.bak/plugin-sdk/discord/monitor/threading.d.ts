import { ChannelType, type Client } from "@buape/carbon";
import { createReplyReferencePlanner } from "../../auto-reply/reply/reply-reference.js";
import type { ReplyToMode } from "../../config/config.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";
import type { DiscordMessageEvent } from "./listeners.js";
export type DiscordThreadChannel = {
    id: string;
    name?: string | null;
    parentId?: string | null;
    parent?: {
        id?: string;
        name?: string;
    };
    ownerId?: string | null;
};
export type DiscordThreadStarter = {
    text: string;
    author: string;
    timestamp?: number;
};
type DiscordThreadParentInfo = {
    id?: string;
    name?: string;
    type?: ChannelType;
};
export declare function __resetDiscordThreadStarterCacheForTest(): void;
export declare function resolveDiscordThreadChannel(params: {
    isGuildMessage: boolean;
    message: DiscordMessageEvent["message"];
    channelInfo: import("./message-utils.js").DiscordChannelInfo | null;
    messageChannelId?: string;
}): DiscordThreadChannel | null;
export declare function resolveDiscordThreadParentInfo(params: {
    client: Client;
    threadChannel: DiscordThreadChannel;
    channelInfo: import("./message-utils.js").DiscordChannelInfo | null;
}): Promise<DiscordThreadParentInfo>;
export declare function resolveDiscordThreadStarter(params: {
    channel: DiscordThreadChannel;
    client: Client;
    parentId?: string;
    parentType?: ChannelType;
    resolveTimestampMs: (value?: string | null) => number | undefined;
}): Promise<DiscordThreadStarter | null>;
export declare function resolveDiscordReplyTarget(opts: {
    replyToMode: ReplyToMode;
    replyToId?: string;
    hasReplied: boolean;
}): string | undefined;
export declare function sanitizeDiscordThreadName(rawName: string, fallbackId: string): string;
type DiscordReplyDeliveryPlan = {
    deliverTarget: string;
    replyTarget: string;
    replyReference: ReturnType<typeof createReplyReferencePlanner>;
};
export type DiscordAutoThreadContext = {
    createdThreadId: string;
    From: string;
    To: string;
    OriginatingTo: string;
    SessionKey: string;
    ParentSessionKey: string;
};
export declare function resolveDiscordAutoThreadContext(params: {
    agentId: string;
    channel: string;
    messageChannelId: string;
    createdThreadId?: string | null;
}): DiscordAutoThreadContext | null;
export type DiscordAutoThreadReplyPlan = DiscordReplyDeliveryPlan & {
    createdThreadId?: string;
    autoThreadContext: DiscordAutoThreadContext | null;
};
export declare function resolveDiscordAutoThreadReplyPlan(params: {
    client: Client;
    message: DiscordMessageEvent["message"];
    messageChannelId?: string;
    isGuildMessage: boolean;
    channelConfig?: DiscordChannelConfigResolved | null;
    threadChannel?: DiscordThreadChannel | null;
    channelType?: ChannelType;
    baseText: string;
    combinedBody: string;
    replyToMode: ReplyToMode;
    agentId: string;
    channel: string;
}): Promise<DiscordAutoThreadReplyPlan>;
export declare function maybeCreateDiscordAutoThread(params: {
    client: Client;
    message: DiscordMessageEvent["message"];
    messageChannelId?: string;
    isGuildMessage: boolean;
    channelConfig?: DiscordChannelConfigResolved | null;
    threadChannel?: DiscordThreadChannel | null;
    channelType?: ChannelType;
    baseText: string;
    combinedBody: string;
}): Promise<string | undefined>;
export declare function resolveDiscordReplyDeliveryPlan(params: {
    replyTarget: string;
    replyToMode: ReplyToMode;
    messageId: string;
    threadChannel?: DiscordThreadChannel | null;
    createdThreadId?: string | null;
}): DiscordReplyDeliveryPlan;
export {};
