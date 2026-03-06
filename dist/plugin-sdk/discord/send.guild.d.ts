import type { APIChannel, APIGuildMember, APIGuildScheduledEvent, APIRole, APIVoiceState, RESTPostAPIGuildScheduledEventJSONBody } from "discord-api-types/v10";
import type { DiscordModerationTarget, DiscordReactOpts, DiscordRoleChange, DiscordTimeoutTarget } from "./send.types.js";
export declare function fetchMemberInfoDiscord(guildId: string, userId: string, opts?: DiscordReactOpts): Promise<APIGuildMember>;
export declare function fetchRoleInfoDiscord(guildId: string, opts?: DiscordReactOpts): Promise<APIRole[]>;
export declare function addRoleDiscord(payload: DiscordRoleChange, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function removeRoleDiscord(payload: DiscordRoleChange, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function fetchChannelInfoDiscord(channelId: string, opts?: DiscordReactOpts): Promise<APIChannel>;
export declare function listGuildChannelsDiscord(guildId: string, opts?: DiscordReactOpts): Promise<APIChannel[]>;
export declare function fetchVoiceStatusDiscord(guildId: string, userId: string, opts?: DiscordReactOpts): Promise<APIVoiceState>;
export declare function listScheduledEventsDiscord(guildId: string, opts?: DiscordReactOpts): Promise<APIGuildScheduledEvent[]>;
export declare function createScheduledEventDiscord(guildId: string, payload: RESTPostAPIGuildScheduledEventJSONBody, opts?: DiscordReactOpts): Promise<APIGuildScheduledEvent>;
export declare function timeoutMemberDiscord(payload: DiscordTimeoutTarget, opts?: DiscordReactOpts): Promise<APIGuildMember>;
export declare function kickMemberDiscord(payload: DiscordModerationTarget, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
export declare function banMemberDiscord(payload: DiscordModerationTarget & {
    deleteMessageDays?: number;
}, opts?: DiscordReactOpts): Promise<{
    ok: boolean;
}>;
