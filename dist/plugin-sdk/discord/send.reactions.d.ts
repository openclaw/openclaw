import type { DiscordReactionSummary, DiscordReactOpts } from "./send.types.js";
export declare function reactMessageDiscord(channelId: string, messageId: string, emoji: string, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function removeReactionDiscord(channelId: string, messageId: string, emoji: string, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function removeOwnReactionsDiscord(channelId: string, messageId: string, opts?: DiscordReactOpts): Promise<{
    ok: true;
    removed: string[];
}>;
export declare function fetchReactionsDiscord(channelId: string, messageId: string, opts?: DiscordReactOpts & {
    limit?: number;
}): Promise<DiscordReactionSummary[]>;
export { fetchChannelPermissionsDiscord } from "./send.permissions.js";
