import {
  normalizeDiscordDisplaySlug,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

export function resolveDiscordPreflightChannelContext(params: {
  isGuildMessage: boolean;
  messageChannelId: string;
  channelName?: string;
  guildName?: string;
  guildInfo: DiscordGuildEntryResolved | null;
  threadChannel: DiscordMessagePreflightContext["threadChannel"];
  threadParentId?: string;
  threadParentName?: string;
}) {
  const threadName = params.threadChannel?.name;
  const displayChannelName = threadName ?? params.channelName;
  const displayChannelSlug = displayChannelName
    ? normalizeDiscordDisplaySlug(displayChannelName)
    : "";
  const guildSlug =
    params.guildInfo?.slug || (params.guildName ? normalizeDiscordSlug(params.guildName) : "");

  const threadChannelSlug = params.channelName ? normalizeDiscordSlug(params.channelName) : "";

  const channelConfig = params.isGuildMessage
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo: params.guildInfo,
        channelId: params.messageChannelId,
        channelName: params.channelName,
        channelSlug: threadChannelSlug,
        parentId: params.threadParentId,
        parentName: params.threadParentName,
        scope: params.threadChannel ? "thread" : "channel",
      })
    : null;

  return {
    threadName,
    displayChannelName,
    displayChannelSlug,
    guildSlug,
    channelConfig,
  };
}
