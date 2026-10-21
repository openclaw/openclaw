import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import {
  ChannelType,
  type Client,
  GatewayDispatchEvents,
  type ListenerDataByEvent,
  type User,
} from "../internal/discord.js";
import {
  hasConfiguredDiscordChannels,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import type { DiscordListenerLogger } from "./listeners.queue.js";
import type { DiscordLivePolicyReader } from "./live-policy.js";
import { resolveFetchedDiscordThreadLikeChannelContext } from "./thread-channel-context.js";

type DiscordReactionEvent = ListenerDataByEvent[GatewayDispatchEvents.MessageReactionAdd];

type DiscordReactionListenerParams = {
  readPolicy?: DiscordLivePolicyReader;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  logger: DiscordListenerLogger;
  onEvent?: () => void;
} & DiscordReactionRoutingParams;

type DiscordReactionRoutingParams = {
  isPolicyCurrent?: () => boolean;
  accountId: string;
  botUserId?: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  allowNameMatching: boolean;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
};

type DiscordFetchedReactionMessage = { author?: User | null } | null;

export class DiscordReactionListener {
  readonly type = GatewayDispatchEvents.MessageReactionAdd;
  constructor(private params: DiscordReactionListenerParams) {}

  async handle(data: DiscordReactionEvent, client: Client) {
    this.params.onEvent?.();
    await runDiscordReactionHandler({
      data,
      client,
      action: "added",
      handlerParams: this.params,
    });
  }
}

export class DiscordReactionRemoveListener {
  readonly type = GatewayDispatchEvents.MessageReactionRemove;
  constructor(private params: DiscordReactionListenerParams) {}

  async handle(data: DiscordReactionEvent, client: Client) {
    this.params.onEvent?.();
    await runDiscordReactionHandler({
      data,
      client,
      action: "removed",
      handlerParams: this.params,
    });
  }
}

async function runDiscordReactionHandler(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  handlerParams: DiscordReactionListenerParams;
}): Promise<void> {
  const policy = await params.handlerParams.readPolicy?.();
  const handlerParams = policy
    ? {
        ...params.handlerParams,
        ...policy,
        isPolicyCurrent: policy.isCurrent,
      }
    : params.handlerParams;
  await handleDiscordReactionEvent({
    ...handlerParams,
    data: params.data,
    client: params.client,
    action: params.action,
  });
}

async function handleDiscordReactionEvent(
  params: {
    data: DiscordReactionEvent;
    client: Client;
    action: "added" | "removed";
    cfg: OpenClawConfig;
    logger: DiscordListenerLogger;
  } & DiscordReactionRoutingParams,
) {
  try {
    const { data, client, action, botUserId, guildEntries } = params;
    if (!("user" in data)) {
      return;
    }
    const user = data.user;
    if (!user || user.bot) {
      return;
    }
    if (botUserId && user.id === botUserId) {
      return;
    }

    const isGuildMessage = Boolean(data.guild_id);
    const guildInfo = isGuildMessage
      ? resolveDiscordGuildEntry({
          guild: data.guild ?? undefined,
          guildId: data.guild_id ?? undefined,
          guildEntries,
        })
      : null;
    if (isGuildMessage && guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }
    const memberRoleIds = Array.isArray(data.rawMember?.roles) ? data.rawMember.roles.slice() : [];
    const reactionMode = guildInfo?.reactionNotifications ?? "own";
    const shouldSkipGuildReactionBeforeChannelFetch = () => {
      if (reactionMode === "off" || params.groupPolicy === "disabled") {
        return true;
      }
      if (reactionMode !== "allowlist") {
        return false;
      }
      if (hasConfiguredDiscordChannels(guildInfo?.channels)) {
        return false;
      }
      return !shouldEmitDiscordReactionNotification({
        mode: reactionMode,
        botId: botUserId,
        userId: user.id,
        userName: user.username,
        userTag: formatDiscordUserTag(user),
        guildInfo,
        memberRoleIds,
        allowNameMatching: params.allowNameMatching,
      });
    };
    if (isGuildMessage && shouldSkipGuildReactionBeforeChannelFetch()) {
      return;
    }

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) {
      return;
    }
    const channelContext = await resolveFetchedDiscordThreadLikeChannelContext({
      client,
      channel,
      channelIdFallback: data.channel_id,
    });
    const channelName = channelContext.channelName;
    const channelSlug = channelContext.channelSlug;
    const channelType = channelContext.channelType;
    const isDirectMessage = channelType === ChannelType.DM;
    const isGroupDm = channelType === ChannelType.GroupDM;
    const isThreadChannel = channelContext.isThreadChannel;
    const authorizeDiscordReactionIngress = async (
      resolvedConfig?: import("./allow-list.js").DiscordChannelConfigResolved | null,
    ): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
      if (params.isPolicyCurrent?.() === false) {
        return { allowed: false, reason: "policy-changed" };
      }
      if (isDirectMessage && !params.dmEnabled) {
        return { allowed: false, reason: "dm-disabled" };
      }
      if (isGroupDm && !params.groupDmEnabled) {
        return { allowed: false, reason: "group-dm-disabled" };
      }
      if (isDirectMessage) {
        const access = await resolveDiscordDmCommandAccess({
          cfg: params.cfg,
          accountId: params.accountId,
          dmPolicy: params.dmPolicy,
          configuredAllowFrom: params.allowFrom,
          sender: {
            id: user.id,
            name: user.username,
            tag: formatDiscordUserTag(user),
          },
          allowNameMatching: params.allowNameMatching,
          eventKind: "reaction",
        });
        if (params.isPolicyCurrent?.() === false) {
          return { allowed: false, reason: "policy-changed" };
        }
        if (access.senderAccess.decision !== "allow") {
          return { allowed: false, reason: access.senderAccess.reasonCode };
        }
      }
      if (
        isGroupDm &&
        !resolveGroupDmAllow({
          channels: params.groupDmChannels,
          channelId: data.channel_id,
          channelName,
          channelSlug,
        })
      ) {
        return { allowed: false, reason: "group-dm-not-allowlisted" };
      }
      if (!isGuildMessage) {
        return { allowed: true };
      }
      const channelAllowlistConfigured = hasConfiguredDiscordChannels(guildInfo?.channels);
      const channelAllowed = resolvedConfig?.allowed !== false;
      if (
        !isDiscordGroupAllowedByPolicy({
          groupPolicy: params.groupPolicy,
          guildAllowlisted: Boolean(guildInfo),
          channelAllowlistConfigured,
          channelAllowed,
        })
      ) {
        return { allowed: false, reason: "guild-policy" };
      }
      if (resolvedConfig?.allowed === false) {
        return { allowed: false, reason: "guild-channel-denied" };
      }
      const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
        channelConfig: resolvedConfig,
        guildInfo,
        memberRoleIds,
        sender: {
          id: user.id,
          name: user.username,
          tag: formatDiscordUserTag(user),
        },
        allowNameMatching: params.allowNameMatching,
      });
      if (hasAccessRestrictions && !memberAllowed) {
        return { allowed: false, reason: "guild-member-denied" };
      }
      return { allowed: true };
    };
    if (!isGuildMessage) {
      const ingressAccess = await authorizeDiscordReactionIngress();
      if (!ingressAccess.allowed) {
        logVerbose(`discord reaction blocked sender=${user.id} (reason=${ingressAccess.reason})`);
        return;
      }
    }
    const parentId = isThreadChannel ? channelContext.threadParentId : channelContext.parentId;
    const parentName = isThreadChannel ? channelContext.threadParentName : undefined;
    const parentSlug = isThreadChannel ? channelContext.threadParentSlug : "";
    if (isThreadChannel && reactionMode === "off") {
      return;
    }
    // Thread authorization follows the message lookup; channel authorization precedes it.
    let message: DiscordFetchedReactionMessage = null;
    if (isThreadChannel && reactionMode === "own") {
      message = await data.message.fetch().catch(() => null);
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      parentId,
      parentName,
      parentSlug,
      scope: isThreadChannel ? "thread" : "channel",
    });
    if (isGuildMessage || isThreadChannel) {
      const access = await authorizeDiscordReactionIngress(channelConfig);
      if (!access.allowed) {
        return;
      }
    }
    if (!isThreadChannel && reactionMode === "own") {
      message = await data.message.fetch().catch(() => null);
    }
    if (
      !shouldEmitDiscordReactionNotification({
        mode: reactionMode,
        botId: botUserId,
        messageAuthorId: message?.author?.id,
        userId: user.id,
        userName: user.username,
        userTag: formatDiscordUserTag(user),
        channelConfig,
        guildInfo,
        memberRoleIds,
        allowNameMatching: params.allowNameMatching,
      })
    ) {
      return;
    }

    const emojiLabel = formatDiscordReactionEmoji(data.emoji);
    // Reaction removals do not include member/user details in Discord's gateway payload.
    const actorLabel = formatDiscordUserTag(user) || user.id;
    const guildSlug =
      guildInfo?.slug ||
      (data.guild?.name
        ? normalizeDiscordSlug(data.guild.name)
        : (data.guild_id ?? (isGroupDm ? "group-dm" : "dm")));
    const channelLabel = channelSlug
      ? `#${channelSlug}`
      : channelName
        ? `#${normalizeDiscordSlug(channelName)}`
        : `#${data.channel_id}`;
    const baseText = `Discord ${data.burst ? "super " : ""}reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
    const authorLabel = message?.author ? formatDiscordUserTag(message.author) : undefined;
    const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
    const contextKey = `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}${data.burst ? ":burst" : ""}`;
    const route = resolveAgentRoute({
      cfg: params.cfg,
      channel: "discord",
      accountId: params.accountId,
      guildId: data.guild_id ?? undefined,
      memberRoleIds,
      peer: {
        kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
        id: isDirectMessage ? user.id : data.channel_id,
      },
      parentPeer: parentId ? { kind: "channel", id: parentId } : undefined,
    });
    enqueueRoutedSystemEvent(text, route, { contextKey });
  } catch (err) {
    params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
  }
}
