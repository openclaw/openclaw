import { ChannelType } from "discord-api-types/v10";
import type { DiscordPermissionsSummary, DiscordReactOpts } from "./send.types.js";
export declare function isThreadChannelType(channelType?: number): channelType is ChannelType.AnnouncementThread | ChannelType.PublicThread | ChannelType.PrivateThread;
/**
 * Fetch guild-level permissions for a user. This does not include channel-specific overwrites.
 */
export declare function fetchMemberGuildPermissionsDiscord(guildId: string, userId: string, opts?: DiscordReactOpts): Promise<bigint | null>;
/**
 * Returns true when the user has ADMINISTRATOR or any required permission bit.
 */
export declare function hasAnyGuildPermissionDiscord(guildId: string, userId: string, requiredPermissions: bigint[], opts?: DiscordReactOpts): Promise<boolean>;
/**
 * Returns true when the user has ADMINISTRATOR or all required permission bits.
 */
export declare function hasAllGuildPermissionsDiscord(guildId: string, userId: string, requiredPermissions: bigint[], opts?: DiscordReactOpts): Promise<boolean>;
/**
 * @deprecated Prefer hasAnyGuildPermissionDiscord or hasAllGuildPermissionsDiscord for clarity.
 */
export declare const hasGuildPermissionDiscord: typeof hasAnyGuildPermissionDiscord;
export declare function fetchChannelPermissionsDiscord(channelId: string, opts?: DiscordReactOpts): Promise<DiscordPermissionsSummary>;
