import { type Message } from "../internal/discord.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import type { DiscordChannelInfo } from "./message-utils.js";
export declare function isBoundThreadBotSystemMessage(params: {
    isBoundThreadSession: boolean;
    isBotAuthor: boolean;
    text?: string;
}): boolean;
type BoundThreadLookupRecordLike = {
    webhookId?: string | null;
    metadata?: {
        webhookId?: string | null;
    };
};
export declare function isDiscordThreadChannelMessage(params: {
    isGuildMessage: boolean;
    message: Message;
    channelInfo: DiscordChannelInfo | null;
}): boolean;
export declare function resolveInjectedBoundThreadLookupRecord(params: {
    threadBindings: DiscordMessagePreflightParams["threadBindings"];
    threadId: string;
}): BoundThreadLookupRecordLike | undefined;
export declare function resolveDiscordMentionState(params: {
    authorIsBot: boolean;
    botId?: string;
    hasAnyMention: boolean;
    isDirectMessage: boolean;
    isExplicitlyMentioned: boolean;
    mentionRegexes: RegExp[];
    mentionText: string;
    mentionedEveryone: boolean;
    referencedAuthorId?: string;
    senderIsPluralKit: boolean;
    transcript?: string;
}): {
    implicitMentionKinds: import("openclaw/plugin-sdk/channel-inbound").InboundImplicitMentionKind[];
    wasMentioned: boolean;
};
export declare function resolvePreflightMentionRequirement(params: {
    shouldRequireMention: boolean;
    bypassMentionRequirement: boolean;
}): boolean;
export declare function shouldIgnoreBoundThreadWebhookMessage(params: {
    accountId?: string;
    threadId?: string;
    webhookId?: string | null;
    threadBinding?: BoundThreadLookupRecordLike;
}): boolean;
export {};
