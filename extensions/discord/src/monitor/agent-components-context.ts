import { ChannelType } from "discord-api-types/v10";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { isDiscordThreadChannelType } from "../channel-type.js";
import { replySilently } from "./agent-components-reply.js";
import type {
  AgentComponentContext,
  AgentComponentInteraction,
  AgentComponentMessageInteraction,
  ComponentInteractionContext,
  DiscordChannelContext,
} from "./agent-components.types.js";
import { normalizeDiscordDisplaySlug, normalizeDiscordSlug } from "./allow-list.js";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";
import {
  resolveDiscordThreadLikeChannelContext,
  resolveFetchedDiscordThreadLikeChannelContext,
} from "./thread-channel-context.js";

// Component callbacks send their first response only after authorization, and modal
// triggers cannot defer at all. Bound channel metadata lookups like the live-policy wait;
// a late lookup still fills the channel cache for the next click.
const COMPONENT_CHANNEL_CONTEXT_WAIT_MS = 1_000;

function formatUsername(user: { username: string; discriminator?: string | null }): string {
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return user.username;
}

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
  replyOpts: { ephemeral?: boolean };
  label: string;
}) {
  try {
    await params.interaction.reply({
      content: "✓",
      ...params.replyOpts,
    });
  } catch (err) {
    logError(`${params.label}: failed to acknowledge interaction: ${String(err)}`);
  }
}

export async function replyUnavailableComponentInteraction(
  interaction: AgentComponentInteraction,
  content: string,
): Promise<void> {
  try {
    await interaction.reply({ content, ephemeral: true });
  } catch {
    // The interaction may have expired before its failure reply could be delivered.
  }
}

function buildDiscordChannelContext(params: {
  channelName: string | undefined;
  channelType: number | undefined;
  isThread: boolean;
  parentId: string | undefined;
  parentName: string | undefined;
}): DiscordChannelContext {
  const { channelName, parentName } = params;
  return {
    ...params,
    channelSlug: channelName ? normalizeDiscordSlug(channelName) : "",
    displayChannelSlug: channelName ? normalizeDiscordDisplaySlug(channelName) : "",
    parentSlug: parentName ? normalizeDiscordSlug(parentName) : "",
  };
}

// Resolves null when a payload without a channel object timed out, or when a guildless one
// has no verified channel type (failed or typeless lookup, or a typeless channel object). Either
// way DM or Group DM policy, allowlist, and routing facts are unknown, so the caller asks for a
// retry instead. A guild payload with an unknown type still resolves: guild policy matches its id.
// Only a thread's parent lookup can time out for a channel object, and its type is verified.
async function resolveDiscordChannelContext(
  interaction: AgentComponentInteraction,
): Promise<DiscordChannelContext | null> {
  const { channel, client } = interaction;
  const channelId = interaction.rawData.channel_id;
  // A hydrated channel already carries its type, name, and thread parent id. Discord can
  // also send channel_id without a channel object; only then is the channel fetched.
  const lookup = channel
    ? resolveFetchedDiscordThreadLikeChannelContext({ client, channel })
    : resolveDiscordThreadLikeChannelContext({ client, channel, channelIdFallback: channelId });
  const timeout = new Error("Discord component channel lookup timed out");
  try {
    const resolved = await withTimeout(lookup, COMPONENT_CHANNEL_CONTEXT_WAIT_MS, {
      createError: () => timeout,
    });
    if (!interaction.rawData.guild_id && resolved.channelType === undefined) {
      logVerbose(`discord component: channel lookup for ${channelId} returned no channel type`);
      return null;
    }
    return buildDiscordChannelContext({
      channelName: resolved.channelName,
      channelType: resolved.channelType,
      isThread: resolved.isThreadChannel,
      parentId: resolved.threadParentId,
      parentName: resolved.threadParentName,
    });
  } catch (error) {
    if (error !== timeout) {
      throw error;
    }
  }
  logVerbose(`discord component: channel lookup for ${channelId} timed out`);
  if (!channel) {
    return null;
  }
  // A hydrated thread still carries its parent id; only parent-name matching is lost.
  const info = resolveDiscordChannelInfoSafe(channel);
  const isThread = isDiscordThreadChannelType(info.type);
  return buildDiscordChannelContext({
    channelName: info.name,
    channelType: info.type,
    isThread,
    parentId: isThread ? info.parentId : undefined,
    parentName: isThread ? info.parentName : undefined,
  });
}

export async function resolveComponentInteractionContext(params: {
  interaction: AgentComponentInteraction;
  label: string;
  defer?: boolean;
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

  const shouldDefer = params.defer !== false && "defer" in interaction;
  let didDefer = false;
  if (shouldDefer) {
    try {
      await (interaction as AgentComponentMessageInteraction).defer({ ephemeral: true });
      didDefer = true;
    } catch (err) {
      logError(`${label}: failed to defer interaction: ${String(err)}`);
    }
  }
  const replyOpts = didDefer ? {} : { ephemeral: true };

  const username = formatUsername(user);
  const userId = user.id;
  const rawGuildId = interaction.rawData.guild_id;
  const channelCtx = await resolveDiscordChannelContext(interaction);
  if (!channelCtx) {
    await replySilently(interaction, {
      content: "Channel details are unavailable right now. Try this interaction again.",
      ...replyOpts,
    });
    return null;
  }
  const channelType = channelCtx.channelType;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isDirectMessage = channelType === ChannelType.DM;
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => roleId)
    : [];

  return {
    channelId,
    user,
    username,
    userId,
    replyOpts,
    rawGuildId,
    isDirectMessage,
    isGroupDm,
    memberRoleIds,
    channelCtx,
  };
}
