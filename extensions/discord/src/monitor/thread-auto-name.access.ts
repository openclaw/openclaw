import type { GatewayMessageCreateDispatchData as APIMessage } from "discord-api-types/v10";
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import { createDiscordActionGate, resolveDiscordAccountConfig } from "../accounts.js";
import { isDiscordThreadChannelType } from "../channel-type.js";
import { getGuildMember, User, type Client } from "../internal/discord.js";
import {
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
} from "./allow-list.js";
import { resolveDiscordChannelInfoSafe } from "./channel-access.js";
import type { DiscordLivePolicy, DiscordLivePolicyReader } from "./live-policy.js";
import { resolveDiscordPreflightChannelAccess } from "./message-handler.preflight-channel-access.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import { resolveDiscordThreadAutoNameThreshold } from "./thread-auto-name.config.js";

export type DiscordAutoNameContributor = Pick<
  APIMessage,
  "channel_id" | "guild_id" | "author" | "member" | "webhook_id"
>;

/** The optional namer uses the same current guild/channel/member admission as replies. */
export async function resolveDiscordAutoNameAccess(params: {
  readPolicy: DiscordLivePolicyReader;
  accountId: string;
  threadId: string;
  guildId: string;
  parentId: string;
  originalName: string;
  botUserId: string;
  client: Client;
  contributors: DiscordAutoNameContributor[];
  refreshMembers?: boolean;
}): Promise<{ policy: DiscordLivePolicy; humanRoleIds: string[] } | null> {
  try {
    const policy = await params.readPolicy();
    if (
      !policy.isCurrent() ||
      policy.accountId !== params.accountId ||
      policy.cfg.channels?.discord?.enabled === false ||
      policy.discordConfig.enabled === false ||
      resolveDiscordAccountConfig(policy.cfg, policy.accountId)?.enabled === false ||
      resolveDiscordThreadAutoNameThreshold(policy.cfg, policy.accountId) <= 0 ||
      !createDiscordActionGate({ cfg: policy.cfg, accountId: policy.accountId })("channels")
    ) {
      return null;
    }
    const guild = await params.client.fetchGuild(params.guildId);
    if (!policy.isCurrent()) {
      return null;
    }
    const guildInfo = resolveDiscordGuildEntry({
      guild,
      guildId: params.guildId,
      guildEntries: policy.guildEntries,
    });
    if (policy.guildEntries && Object.keys(policy.guildEntries).length > 0 && !guildInfo) {
      return null;
    }
    const thread = resolveDiscordChannelInfoSafe(await params.client.fetchChannel(params.threadId));
    if (
      !policy.isCurrent() ||
      !isDiscordThreadChannelType(thread.type) ||
      thread.parentId !== params.parentId ||
      thread.name !== params.originalName
    ) {
      return null;
    }
    const parent = resolveDiscordChannelInfoSafe(await params.client.fetchChannel(params.parentId));
    if (!policy.isCurrent() || parent.type === undefined) {
      return null;
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: params.threadId,
      channelName: thread.name,
      channelSlug: normalizeDiscordSlug(thread.name ?? ""),
      parentId: params.parentId,
      parentName: parent.name,
      parentSlug: normalizeDiscordSlug(parent.name ?? ""),
      scope: "thread",
    });
    if (
      !resolveDiscordPreflightChannelAccess({
        isGuildMessage: true,
        isGroupDm: false,
        groupPolicy: policy.groupPolicy,
        messageChannelId: params.threadId,
        displayChannelName: thread.name,
        displayChannelSlug: normalizeDiscordSlug(thread.name ?? ""),
        guildInfo,
        channelConfig,
        channelMatchMeta: formatAllowlistMatchMeta(channelConfig),
      })
    ) {
      return null;
    }
    const refreshedRoles = new Map<string, string[]>();
    let hasHuman = false;
    let hasAgent = false;
    let humanRoleIds: string[] | undefined;
    for (const message of params.contributors) {
      if (
        message.channel_id !== params.threadId ||
        (message.guild_id && message.guild_id !== params.guildId) ||
        message.webhook_id
      ) {
        return null;
      }
      if (message.author.id === params.botUserId) {
        hasAgent = true;
        continue;
      }
      if (message.author.bot) {
        return null;
      }
      let memberRoleIds = message.member?.roles ?? [];
      if (params.refreshMembers) {
        let roles = refreshedRoles.get(message.author.id);
        if (!roles) {
          // Final effects need current membership rather than the REST entity cache.
          roles = (await getGuildMember(params.client.rest, params.guildId, message.author.id))
            .roles;
          if (!policy.isCurrent()) {
            return null;
          }
          refreshedRoles.set(message.author.id, roles);
        }
        memberRoleIds = roles;
      }
      const sender = resolveDiscordSenderIdentity({
        author: new User(params.client, message.author),
        member: message.member,
      });
      if (
        !resolveDiscordMemberAccessState({
          channelConfig,
          guildInfo,
          memberRoleIds,
          sender,
          allowNameMatching: policy.allowNameMatching,
        }).memberAllowed
      ) {
        return null;
      }
      hasHuman = true;
      humanRoleIds ??= memberRoleIds;
    }
    return policy.isCurrent() && (!hasAgent || hasHuman)
      ? { policy, humanRoleIds: humanRoleIds ?? [] }
      : null;
  } catch {
    // Missing policy, channel, or member authority disables this optional effect.
    return null;
  }
}
