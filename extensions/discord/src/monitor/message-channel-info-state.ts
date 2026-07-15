import type { DiscordChannelInfo } from "./message-channel-info.js";

export const discordChannelInfoCacheState = {
  entries: new Map<string, { value: DiscordChannelInfo | null; expiresAt: number }>(),
};
