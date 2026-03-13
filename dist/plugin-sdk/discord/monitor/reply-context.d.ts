import type { Guild, Message, User } from "@buape/carbon";
export type DiscordReplyContext = {
    id: string;
    channelId: string;
    sender: string;
    body: string;
    timestamp?: number;
};
export declare function resolveReplyContext(message: Message, resolveDiscordMessageText: (message: Message, options?: {
    includeForwarded?: boolean;
}) => string): DiscordReplyContext | null;
export declare function buildDirectLabel(author: User, tagOverride?: string): string;
export declare function buildGuildLabel(params: {
    guild?: Guild<true> | Guild;
    channelName: string;
    channelId: string;
}): string;
