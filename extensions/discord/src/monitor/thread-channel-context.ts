import { isDiscordThreadChannelType } from "../channel-type.js";
import type { ChannelType } from "../internal/discord.js";
import { normalizeDiscordSlug } from "./allow-list.js";
import {
  resolveDiscordChannelIdSafe,
  resolveDiscordChannelInfoSafe,
  resolveDiscordChannelParentIdSafe,
} from "./channel-access.js";
import { buildDiscordChannelInfo, resolveDiscordChannelInfo } from "./message-channel-info.js";
import type { DiscordChannelInfo, DiscordChannelInfoClient } from "./message-channel-info.js";
import { resolveDiscordThreadParentInfo } from "./threading.starter.js";

export async function resolveDiscordThreadLikeChannelContext(params: {
  client: DiscordChannelInfoClient;
  channel: unknown;
  channelIdFallback?: string;
  channelInfo?: DiscordChannelInfo | null;
}) {
  const safeChannelInfo = resolveDiscordChannelInfoSafe(params.channel);
  const channelId = resolveDiscordChannelIdSafe(params.channel) ?? params.channelIdFallback ?? "";
  const channelInfo =
    params.channelInfo !== undefined
      ? params.channelInfo
      : channelId
        ? await resolveDiscordChannelInfo(params.client, channelId)
        : null;
  const channelType = (safeChannelInfo.type as ChannelType | undefined) ?? channelInfo?.type;
  const channelName = safeChannelInfo.name ?? channelInfo?.name;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const parentId = resolveDiscordChannelParentIdSafe(params.channel) ?? channelInfo?.parentId;
  const isThreadChannel = isDiscordThreadChannelType(channelType);

  let threadParentId: string | undefined;
  let threadParentName: string | undefined;
  let threadParentSlug = "";
  if (channelId && isThreadChannel) {
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: params.client,
      threadChannel: {
        id: channelId,
        name: channelName,
        parentId,
        parent: undefined,
      },
      channelInfo,
    });
    threadParentId = parentInfo.id;
    threadParentName = parentInfo.name;
    threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  }

  return {
    channelType,
    isThreadChannel,
    channelId,
    channelName,
    channelSlug,
    parentId,
    threadParentId,
    threadParentName,
    threadParentSlug,
    channelInfo,
  };
}

export async function resolveFetchedDiscordThreadLikeChannelContext(params: {
  client: DiscordChannelInfoClient;
  channel: unknown;
  channelIdFallback?: string;
}) {
  return await resolveDiscordThreadLikeChannelContext({
    ...params,
    channelInfo: buildDiscordChannelInfo(params.channel),
  });
}
