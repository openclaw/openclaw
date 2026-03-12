import type { Guild, User } from "@buape/carbon";
export declare function resolveDiscordSystemLocation(params: {
    isDirectMessage: boolean;
    isGroupDm: boolean;
    guild?: Guild;
    channelName: string;
}): string;
export declare function formatDiscordReactionEmoji(emoji: {
    id?: string | null;
    name?: string | null;
}): string;
export declare function formatDiscordUserTag(user: User): string;
export declare function resolveTimestampMs(timestamp?: string | null): number | undefined;
