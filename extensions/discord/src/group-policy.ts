import type { ChannelGroupContext } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type GroupToolPolicyConfig,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
import type { DiscordConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeAtHashSlug as normalizeDiscordSlug } from "openclaw/plugin-sdk/string-normalization-runtime";
import { resolveDiscordAccountConfig } from "./accounts.js";
import {
  findDiscordChannelPolicyKey,
  findDiscordGuildPolicyKey,
  getDiscordChannelPolicyBinding,
} from "./channel-policy-state.js";

function resolveDiscordGuildKey(
  guilds: DiscordConfig["guilds"],
  groupSpace?: string | null,
  accountId?: string | null,
): string | undefined {
  if (!guilds || Object.keys(guilds).length === 0) {
    return undefined;
  }
  const space = normalizeOptionalString(groupSpace) ?? "";
  if (space && guilds[space]) {
    return space;
  }
  const boundKey = findDiscordGuildPolicyKey(accountId, space);
  if (boundKey !== undefined && guilds[boundKey]) {
    return boundKey;
  }
  const normalized = normalizeDiscordSlug(space);
  if (normalized && guilds[normalized]) {
    return normalized;
  }
  if (normalized) {
    const match = Object.entries(guilds).find(
      ([, entry]) => normalizeDiscordSlug(entry?.slug ?? undefined) === normalized,
    );
    if (match) {
      return match[0];
    }
  }
  return guilds["*"] ? "*" : undefined;
}

function resolveDiscordChannelKey(
  channelEntries: NonNullable<DiscordConfig["guilds"]>[string]["channels"],
  params: { groupId?: string | null; groupChannel?: string | null },
): string | undefined {
  if (!channelEntries || Object.keys(channelEntries).length === 0) {
    return undefined;
  }
  const groupChannel = params.groupChannel;
  const channelSlug = normalizeDiscordSlug(groupChannel);
  if (params.groupId && channelEntries[params.groupId]) {
    return params.groupId;
  }
  if (channelSlug && channelEntries[channelSlug]) {
    return channelSlug;
  }
  if (channelSlug && channelEntries[`#${channelSlug}`]) {
    return `#${channelSlug}`;
  }
  return groupChannel && channelEntries[channelSlug] ? channelSlug : undefined;
}

function resolveDiscordPolicyScope(params: ChannelGroupContext): {
  tree: ScopeTree;
  path: string[];
} {
  const guilds =
    (params.accountId
      ? resolveDiscordAccountConfig(params.cfg, params.accountId)?.guilds
      : undefined) ?? params.cfg.channels?.discord?.guilds;
  // Guild "*" is selected only after every guild candidate misses; matched guilds hide it.
  // Within the selected guild, channel fields still cascade to guild fields.
  const guildKey = resolveDiscordGuildKey(guilds, params.groupSpace, params.accountId);
  const guild = guildKey ? guilds?.[guildKey] : undefined;
  if (!guildKey || !guild) {
    return { tree: { scopes: {} }, path: [] };
  }
  const channels = guild.channels;
  let channelKey = resolveDiscordChannelKey(channels, params);
  if (channelKey !== params.groupId) {
    // Resolved name keys bind to their channel id: the bound channel keeps its entry after a
    // rename, and threads or other channels that share the name never select it.
    const boundKey = params.groupId
      ? findDiscordChannelPolicyKey(params.accountId, guildKey, params.groupId)
      : undefined;
    if (boundKey !== undefined && channels?.[boundKey]) {
      channelKey = boundKey;
    } else if (
      channelKey !== undefined &&
      getDiscordChannelPolicyBinding(params.accountId, guildKey, channelKey) !== undefined
    ) {
      channelKey = undefined;
    }
  }
  const channel = channelKey !== undefined ? channels?.[channelKey] : undefined;
  return {
    tree: { scopes: { guild, ...(channel ? { channel } : {}) } },
    path: channel ? ["guild", "channel"] : ["guild"],
  };
}

export function resolveDiscordGroupRequireMention(params: ChannelGroupContext): boolean {
  return resolveScopeRequireMention(resolveDiscordPolicyScope(params));
}

export function resolveDiscordGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const scope = resolveDiscordPolicyScope(params);
  // No messageProvider: channel-prefixed sender keys were historically dead here.
  return resolveScopeToolsPolicy({
    ...scope,
    senderPolicyMode: params.senderPolicyMode,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
}
