import type { OpenClawConfig } from "../config/config.js";
import type {
  DiscordAccountConfig,
  DiscordGuildChannelConfig,
  TelegramAccountConfig,
  TelegramTopicConfig,
} from "../config/types.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { pickFirstExistingAgentId } from "../routing/resolve-route.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { parseTelegramTopicConversation } from "./conversation-id.js";
import {
  normalizeBindingConfig,
  normalizeMode,
  toConfiguredAcpBindingRecord,
  type AcpBindingConfigShape,
  type ConfiguredAcpBindingChannel,
  type ConfiguredAcpBindingSpec,
  type ResolvedConfiguredAcpBinding,
} from "./persistent-bindings.types.js";

function resolveDiscordAccountConfig(cfg: OpenClawConfig, accountId: string): DiscordAccountConfig {
  const discord = cfg.channels?.discord;
  if (!discord) {
    return {};
  }
  const { accounts: _ignored, ...base } = discord as DiscordAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountEntry(discord.accounts, accountId) ?? {};
  return { ...base, ...account };
}

function resolveTelegramAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelegramAccountConfig {
  const telegram = cfg.channels?.telegram;
  if (!telegram) {
    return {};
  }
  const {
    accounts: _ignoredAccounts,
    defaultAccount: _ignoredDefaultAccount,
    groups: channelGroups,
    ...base
  } = telegram as TelegramAccountConfig & {
    accounts?: unknown;
    defaultAccount?: unknown;
  };
  const account = resolveAccountEntry(telegram.accounts, accountId) ?? {};
  const configuredAccountIds = Object.keys(telegram.accounts ?? {});
  const isMultiAccount = configuredAccountIds.length > 1;
  const groups = account.groups ?? (isMultiAccount ? undefined : channelGroups);
  return { ...base, ...account, groups };
}

function findDiscordChannelBinding(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversationCandidates: string[];
}): {
  channelId: string;
  binding: AcpBindingConfigShape;
  channelConfig: DiscordGuildChannelConfig;
} | null {
  const discordConfig = resolveDiscordAccountConfig(params.cfg, params.accountId);
  const guilds = discordConfig.guilds;
  if (!guilds || typeof guilds !== "object") {
    return null;
  }
  for (const guild of Object.values(guilds)) {
    const channels = guild?.channels;
    if (!channels || typeof channels !== "object") {
      continue;
    }
    for (const candidate of params.conversationCandidates) {
      const channelConfig = channels[candidate];
      if (!channelConfig || typeof channelConfig !== "object") {
        continue;
      }
      const rawBinding = channelConfig.bindings?.acp;
      const binding = normalizeBindingConfig(rawBinding);
      if (!binding) {
        continue;
      }
      return {
        channelId: candidate,
        binding,
        channelConfig,
      };
    }
  }
  return null;
}

function findTelegramTopicBinding(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): {
  topicConfig: TelegramTopicConfig;
  binding: AcpBindingConfigShape;
  chatId: string;
  topicId: string;
  canonicalConversationId: string;
} | null {
  const parsed = parseTelegramTopicConversation({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!parsed) {
    return null;
  }
  if (!parsed.chatId.startsWith("-")) {
    return null;
  }
  const telegramConfig = resolveTelegramAccountConfig(params.cfg, params.accountId);
  const groupConfig = telegramConfig.groups?.[parsed.chatId];
  const topicConfig = groupConfig?.topics?.[parsed.topicId];
  if (!topicConfig || typeof topicConfig !== "object") {
    return null;
  }
  const binding = normalizeBindingConfig(topicConfig.bindings?.acp);
  if (!binding) {
    return null;
  }
  return {
    topicConfig,
    binding,
    chatId: parsed.chatId,
    topicId: parsed.topicId,
    canonicalConversationId: parsed.canonicalConversationId,
  };
}

function toConfiguredBindingSpec(params: {
  cfg: OpenClawConfig;
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  binding: AcpBindingConfigShape;
}): ConfiguredAcpBindingSpec {
  const accountId = normalizeAccountId(params.accountId);
  const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
  return {
    channel: params.channel,
    accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
    agentId,
    mode: normalizeMode(params.binding.mode),
    cwd: params.binding.cwd,
    backend: params.binding.backend,
    label: params.binding.label,
  };
}

export function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null {
  const channel = params.channel.trim().toLowerCase();
  const accountId = normalizeAccountId(params.accountId);
  const conversationId = params.conversationId.trim();
  const parentConversationId = params.parentConversationId?.trim() || undefined;
  if (!conversationId) {
    return null;
  }

  if (channel === "discord") {
    const resolved = findDiscordChannelBinding({
      cfg: params.cfg,
      accountId,
      conversationCandidates: [conversationId, parentConversationId].filter(
        (value): value is string => Boolean(value),
      ),
    });
    if (!resolved) {
      return null;
    }
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel: "discord",
      accountId,
      conversationId: resolved.channelId,
      binding: resolved.binding,
    });
    return {
      spec,
      record: toConfiguredAcpBindingRecord(spec),
    };
  }

  if (channel === "telegram") {
    const resolved = findTelegramTopicBinding({
      cfg: params.cfg,
      accountId,
      conversationId,
      parentConversationId,
    });
    if (!resolved) {
      return null;
    }
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel: "telegram",
      accountId,
      conversationId: resolved.canonicalConversationId,
      parentConversationId: resolved.chatId,
      binding: resolved.binding,
    });
    return {
      spec,
      record: toConfiguredAcpBindingRecord(spec),
    };
  }

  return null;
}
