import {
  ChannelType,
  type BaseComponentInteraction,
  type CommandInteraction,
} from "../internal/discord.js";
import { resolveDiscordThreadLikeChannelContext } from "./thread-channel-context.js";

export async function resolveDiscordNativeInteractionChannelContext(
  interaction: CommandInteraction | BaseComponentInteraction,
  channelIdFallback: string,
) {
  const { channel, client, guild, rawData } = interaction;
  const hasGuild = Boolean(guild);
  const channelContext = await resolveDiscordThreadLikeChannelContext({
    client,
    channel,
    channelIdFallback: rawData.channel_id ?? channelIdFallback,
  });
  const channelType = channelContext.channelType;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;

  return {
    channelType,
    isDirectMessage,
    isGroupDm,
    isThreadChannel: channelContext.isThreadChannel,
    channelName: channelContext.channelName,
    channelSlug: channelContext.channelSlug,
    rawChannelId: channelContext.channelId,
    threadParentId: hasGuild ? channelContext.threadParentId : undefined,
    threadParentName: hasGuild ? channelContext.threadParentName : undefined,
    threadParentSlug: hasGuild ? channelContext.threadParentSlug : "",
  };
}
