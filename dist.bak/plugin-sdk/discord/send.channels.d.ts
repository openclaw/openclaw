import type { APIChannel } from "discord-api-types/v10";
import type { DiscordChannelCreate, DiscordChannelEdit, DiscordChannelMove, DiscordChannelPermissionSet, DiscordReactOpts } from "./send.types.js";
export declare function createChannelDiscord(payload: DiscordChannelCreate, opts?: DiscordReactOpts): Promise<APIChannel>;
export declare function editChannelDiscord(payload: DiscordChannelEdit, opts?: DiscordReactOpts): Promise<APIChannel>;
export declare function deleteChannelDiscord(channelId: string, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
    channelId: string;
}>;
export declare function moveChannelDiscord(payload: DiscordChannelMove, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function setChannelPermissionDiscord(payload: DiscordChannelPermissionSet, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function removeChannelPermissionDiscord(channelId: string, targetId: string, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
