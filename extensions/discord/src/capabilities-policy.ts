import type { ChannelStatusAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { resolveDiscordAccountConfig, type ResolvedDiscordAccount } from "./accounts.js";
import { isDiscordThreadChannelType } from "./channel-type.js";
import {
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMentionPolicy,
} from "./monitor/allow-list.js";
import { resolveDiscordPreflightChannelAccess } from "./monitor/message-handler.preflight-channel-access.js";
import type { DiscordPermissionsSummary } from "./send.types.js";

type PolicyDiagnostics = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<ChannelStatusAdapter<ResolvedDiscordAccount>["buildCapabilitiesDiagnostics"]>
    >
  >
>;

/** Config-only explanation; not a sender decision or a Gateway connection check. */
export function buildDiscordMessagePolicyDiagnostics(params: {
  cfg: OpenClawConfig;
  account: ResolvedDiscordAccount;
  target: DiscordPermissionsSummary;
}): PolicyDiagnostics {
  const { cfg, account, target } = params;
  const accountConfig = resolveDiscordAccountConfig(cfg, account.accountId);
  const guildsPath =
    accountConfig?.guilds !== undefined
      ? "channels.discord.accounts." + account.accountId + ".guilds"
      : "channels.discord.guilds";
  const guildEntries = account.config.guilds;
  const guildInfo = resolveDiscordGuildEntry({
    guildId: target.guildId,
    guild:
      target.guildId && target.guildName !== undefined
        ? { id: target.guildId, name: target.guildName }
        : undefined,
    guildEntries,
  });
  // Names resolved at Gateway startup can bind to IDs after a rename. This CLI
  // only has authored config; do not diagnose a denial from an unresolved name.
  const hasNamedEntries =
    (!guildEntries?.[target.guildId ?? ""] &&
      Object.keys(guildEntries ?? {}).some((key) => key !== "*" && !/^\d+$/.test(key))) ||
    Object.keys(guildInfo?.channels ?? {}).some(
      (channel) => channel !== "*" && !/^\d+$/.test(channel),
    );
  const isThread = isDiscordThreadChannelType(target.channelType);
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: target.channelId,
    channelName: target.channelName,
    channelSlug: normalizeDiscordSlug(target.channelName ?? ""),
    parentId: target.parentId,
    parentName: target.parentName,
    scope: isThread ? "thread" : "channel",
  });
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.discord !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
  });
  const groupPolicySource =
    accountConfig?.groupPolicy !== undefined
      ? "channels.discord.accounts." + account.accountId + ".groupPolicy"
      : cfg.channels?.discord?.groupPolicy !== undefined
        ? "channels.discord.groupPolicy"
        : cfg.channels?.defaults?.groupPolicy !== undefined
          ? "channels.defaults.groupPolicy"
          : "default";
  const lines: NonNullable<PolicyDiagnostics["lines"]> = [
    {
      text:
        "Message policy (local config): groupPolicy=" +
        groupPolicy +
        " (source: " +
        groupPolicySource +
        ")",
    },
  ];
  if (hasNamedEntries) {
    return {
      details: {
        groupPolicy,
        groupPolicySource,
        guildsPath,
        senderAccess: "not-evaluated",
        unresolved: "name-based-config",
      },
      lines: [
        ...lines,
        {
          text:
            "Message policy: unresolved name-based entries under " +
            guildsPath +
            "; use numeric guild/channel IDs to inspect the effective mention policy.",
          tone: "warn",
        },
      ],
    };
  }
  const guildKey = target.guildId && guildEntries?.[target.guildId] ? target.guildId : "*";
  const guildPath = guildsPath + "[" + JSON.stringify(guildKey) + "]";
  const channelPath = channelConfig?.matchKey
    ? guildPath + ".channels[" + JSON.stringify(channelConfig.matchKey) + "]"
    : guildPath + ".channels";
  const guildExcluded = Boolean(guildEntries && Object.keys(guildEntries).length && !guildInfo);
  const channelAllowed =
    !guildExcluded &&
    resolveDiscordPreflightChannelAccess({
      isGuildMessage: true,
      isGroupDm: false,
      groupPolicy,
      messageChannelId: target.channelId,
      displayChannelName: target.channelName,
      displayChannelSlug: normalizeDiscordSlug(target.channelName ?? ""),
      guildInfo,
      channelConfig,
      channelMatchMeta: "capabilities diagnostic",
    });
  const mention = resolveDiscordMentionPolicy({
    isGuildMessage: true,
    isThread,
    botId: target.botId,
    threadOwnerId: target.threadOwnerId,
    channelConfig,
    guildInfo,
  });
  const mentionSource =
    mention.source === "channel"
      ? channelPath + "." + mention.setting
      : mention.source === "guild"
        ? guildPath + "." + mention.setting
        : mention.source === "autoThread"
          ? channelPath + ".autoThread (bot-owned thread)"
          : "default";
  const channelSource =
    groupPolicy === "disabled"
      ? groupPolicySource
      : guildExcluded || !guildInfo
        ? guildsPath
        : channelConfig
          ? channelPath
          : guildPath;
  lines.push(
    {
      text:
        "Channel access: " +
        (channelAllowed ? "allowed" : "blocked") +
        " (source: " +
        channelSource +
        ")",
      tone: channelAllowed ? "success" : "warn",
    },
    {
      text:
        "Mentions: requireMention=" + mention.requireMention + " (source: " + mentionSource + ")",
    },
    {
      text: "Sender access: not evaluated; no sender context was supplied. Guild/channel users and roles still apply.",
    },
  );
  if (isThread) {
    lines.push({
      text: "Thread route activation is not checked; a bound thread session can bypass the configured mention requirement.",
    });
  }
  if (channelAllowed) {
    lines.push({
      text: "First test: mention the bot in this allowed channel from an allowed sender. Check channels status --probe separately for Gateway connectivity.",
    });
  }
  return {
    details: {
      groupPolicy,
      groupPolicySource,
      channelAllowed,
      channelSource,
      requireMention: mention.requireMention,
      mentionSource,
      senderAccess: "not-evaluated",
      threadRoute: isThread ? "not-evaluated" : undefined,
    },
    lines,
  };
}
