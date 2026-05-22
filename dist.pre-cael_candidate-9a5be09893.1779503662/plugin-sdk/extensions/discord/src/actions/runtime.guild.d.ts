import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ActionGate, type DiscordActionConfig, type OpenClawConfig } from "../runtime-api.js";
import { addRoleDiscord, createChannelDiscord, createScheduledEventDiscord, deleteChannelDiscord, editChannelDiscord, fetchChannelInfoDiscord, fetchMemberInfoDiscord, fetchRoleInfoDiscord, fetchVoiceStatusDiscord, listGuildChannelsDiscord, listGuildEmojisDiscord, listScheduledEventsDiscord, moveChannelDiscord, removeChannelPermissionDiscord, removeRoleDiscord, setChannelPermissionDiscord, uploadEmojiDiscord, uploadStickerDiscord, resolveEventCoverImage } from "../send.js";
export declare const discordGuildActionRuntime: {
    addRoleDiscord: typeof addRoleDiscord;
    createChannelDiscord: typeof createChannelDiscord;
    createScheduledEventDiscord: typeof createScheduledEventDiscord;
    resolveEventCoverImage: typeof resolveEventCoverImage;
    deleteChannelDiscord: typeof deleteChannelDiscord;
    editChannelDiscord: typeof editChannelDiscord;
    fetchChannelInfoDiscord: typeof fetchChannelInfoDiscord;
    fetchMemberInfoDiscord: typeof fetchMemberInfoDiscord;
    fetchRoleInfoDiscord: typeof fetchRoleInfoDiscord;
    fetchVoiceStatusDiscord: typeof fetchVoiceStatusDiscord;
    listGuildChannelsDiscord: typeof listGuildChannelsDiscord;
    listGuildEmojisDiscord: typeof listGuildEmojisDiscord;
    listScheduledEventsDiscord: typeof listScheduledEventsDiscord;
    moveChannelDiscord: typeof moveChannelDiscord;
    removeChannelPermissionDiscord: typeof removeChannelPermissionDiscord;
    removeRoleDiscord: typeof removeRoleDiscord;
    setChannelPermissionDiscord: typeof setChannelPermissionDiscord;
    uploadEmojiDiscord: typeof uploadEmojiDiscord;
    uploadStickerDiscord: typeof uploadStickerDiscord;
};
export declare function handleDiscordGuildAction(action: string, params: Record<string, unknown>, isActionEnabled: ActionGate<DiscordActionConfig>, cfg: OpenClawConfig, options?: {
    mediaLocalRoots?: readonly string[];
}): Promise<AgentToolResult<unknown>>;
