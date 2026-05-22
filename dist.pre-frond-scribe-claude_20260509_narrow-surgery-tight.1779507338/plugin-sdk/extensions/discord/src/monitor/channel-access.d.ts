export type DiscordChannelInfoSafe = {
    name?: string;
    topic?: string;
    type?: number;
    parentId?: string;
    ownerId?: string;
    parentName?: string;
};
export declare function resolveDiscordChannelNameSafe(channel: unknown): string | undefined;
export declare function resolveDiscordChannelIdSafe(channel: unknown): string | undefined;
export declare function resolveDiscordChannelTopicSafe(channel: unknown): string | undefined;
export declare function resolveDiscordChannelParentIdSafe(channel: unknown): string | undefined;
export declare function resolveDiscordChannelOwnerIdSafe(channel: unknown): string | undefined;
export declare function resolveDiscordChannelParentSafe(channel: unknown): unknown;
export declare function resolveDiscordChannelInfoSafe(channel: unknown): DiscordChannelInfoSafe;
