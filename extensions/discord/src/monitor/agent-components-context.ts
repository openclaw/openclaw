import { ChannelType } from "discord-api-types/v10";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { isDiscordThreadChannelType } from "../channel-type.js";
import { replySilently } from "./agent-components-reply.js";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  ComponentInteractionContext,
  DiscordChannelContext,
} from "./agent-components.types.js";
import { normalizeDiscordDisplaySlug, normalizeDiscordSlug } from "./allow-list.js";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";

export function resolveAgentComponentRoute(params: {
  ctx: AgentComponentContext;
  rawGuildId: string | undefined;
  memberRoleIds: string[];
  isDirectMessage: boolean;
  isGroupDm: boolean;
  userId: string;
  channelId: string;
  parentId: string | undefined;
}) {
  return resolveAgentRoute({
    cfg: params.ctx.cfg,
    channel: "discord",
    accountId: params.ctx.accountId,
    guildId: params.rawGuildId,
    memberRoleIds: params.memberRoleIds,
    peer: {
      kind: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
      id: params.isDirectMessage ? params.userId : params.channelId,
    },
    parentPeer: params.parentId ? { kind: "channel", id: params.parentId } : undefined,
  });
}

export async function ackComponentInteraction(params: {
  interaction: AgentComponentInteraction;
  label: string;
}) {
  await replySilently(params.interaction, { content: "✓", ephemeral: true }, (err) => {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  });
}

export async function replyUnavailableComponentInteraction(
  interaction: AgentComponentInteraction,
  content: string,
): Promise<void> {
  await replySilently(interaction, { content, ephemeral: true });
}

export function resolveDiscordChannelContext(
  interaction: AgentComponentInteraction,
): DiscordChannelContext {
  const channel = interaction.channel;
  const channelInfo = resolveDiscordChannelInfoSafe(channel);
  const channelName = channelInfo.name;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const displayChannelSlug = channelName ? normalizeDiscordDisplaySlug(channelName) : "";
  const channelType = channelInfo.type;
  const isThread = isDiscordThreadChannelType(channelType);

  const parentId = isThread ? channelInfo.parentId : undefined;
  const parentName = isThread ? channelInfo.parentName : undefined;
  const parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";

  return {
    channelName,
    channelSlug,
    displayChannelSlug,
    channelType,
    isThread,
    parentId,
    parentName,
    parentSlug,
  };
}

export async function resolveComponentInteractionContext(params: {
  interaction: AgentComponentInteraction;
  label: string;
}): Promise<ComponentInteractionContext | null> {
  const { interaction, label } = params;
  const channelId = interaction.rawData.channel_id;
  if (!channelId) {
    logError(`${label}: missing channel_id in interaction`);
    return null;
  }

  const user = interaction.user;
  if (!user) {
    logError(`${label}: missing user in interaction`);
    return null;
  }

  const username =
    user.discriminator && user.discriminator !== "0"
      ? `${user.username}#${user.discriminator}`
      : user.username;
  const userId = user.id;
  const rawGuildId = interaction.rawData.guild_id;
  const channelType = resolveDiscordChannelContext(interaction).channelType;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isDirectMessage =
    channelType === ChannelType.DM || (!rawGuildId && !isGroupDm && channelType == null);
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.slice()
    : [];

  return {
    channelId,
    user,
    username,
    userId,
    rawGuildId,
    isDirectMessage,
    isGroupDm,
    memberRoleIds,
  };
}
