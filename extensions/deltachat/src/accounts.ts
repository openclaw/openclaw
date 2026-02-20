import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type {
  CoreConfig,
  DeltaChatAccountConfig,
  DeltaChatAccountConfigWithAccounts,
} from "./types.js";

export interface ResolvedDeltaChatAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  baseUrl?: string;
  config: DeltaChatAccountConfig;
}

export function listDeltaChatAccountIds(cfg: OpenClawConfig): string[] {
  const coreCfg = cfg as CoreConfig;
  const baseConfigured =
    coreCfg.channels?.deltachat?.addr || coreCfg.channels?.deltachat?.chatmailQr
      ? [DEFAULT_ACCOUNT_ID]
      : [];
  const accountsConfig = coreCfg.channels?.deltachat?.accounts;
  if (!accountsConfig) {
    return baseConfigured;
  }
  return [...baseConfigured, ...Object.keys(accountsConfig)];
}

export function resolveDefaultDeltaChatAccountId(cfg: OpenClawConfig): string {
  const coreCfg = cfg as CoreConfig;
  if (coreCfg.channels?.deltachat?.addr || coreCfg.channels?.deltachat?.chatmailQr) {
    return DEFAULT_ACCOUNT_ID;
  }
  const accountsConfig = coreCfg.channels?.deltachat?.accounts;
  if (accountsConfig) {
    const ids = Object.keys(accountsConfig);
    if (ids.length > 0) {
      return ids[0];
    }
  }
  return DEFAULT_ACCOUNT_ID;
}

export function resolveDeltaChatAccount({
  cfg,
  accountId,
}: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedDeltaChatAccount {
  const coreCfg = cfg as CoreConfig;
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const baseConfig = coreCfg.channels?.deltachat ?? {};
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;

  let accountConfig: DeltaChatAccountConfig;
  let name: string;
  let enabled: boolean;
  let configured: boolean;

  if (isDefaultAccount) {
    accountConfig = {
      enabled: baseConfig.enabled ?? true,
      configured: Boolean(
        (baseConfig.addr && (baseConfig.mail_pw || baseConfig.chatmailQr)) || baseConfig.chatmailQr,
      ),
      dataDir: baseConfig.dataDir,
      addr: baseConfig.addr,
      mail_pw: baseConfig.mail_pw,
      bot: baseConfig.bot,
      e2ee_enabled: baseConfig.e2ee_enabled,
      chatmailQr: baseConfig.chatmailQr,
      dm: baseConfig.dm,
      groupPolicy: baseConfig.groupPolicy,
      groupAllowFrom: baseConfig.groupAllowFrom,
      groups: baseConfig.groups as DeltaChatAccountConfig["groups"],
      mediaMaxMb: baseConfig.mediaMaxMb,
      replyToMode: baseConfig.replyToMode,
      initialSyncLimit: baseConfig.initialSyncLimit,
      reactionLevel: baseConfig.reactionLevel,
      actions: baseConfig.actions,
      ackReaction: baseConfig.ackReaction,
      ackReactionScope: baseConfig.ackReactionScope,
      livenessReactionsEnabled: baseConfig.livenessReactionsEnabled,
      livenessReactionIntervalSeconds: baseConfig.livenessReactionIntervalSeconds,
    };
    name = baseConfig.addr ?? baseConfig.chatmailQr?.split(":")[1] ?? "Delta.Chat";
    enabled = accountConfig.enabled ?? true;
    configured = accountConfig.configured;
  } else {
    const accountsConfig = coreCfg.channels?.deltachat?.accounts;
    const account = accountsConfig?.[resolvedAccountId];
    if (!account) {
      throw new Error(`Delta.Chat account ${resolvedAccountId} not found`);
    }
    accountConfig = {
      enabled: account.enabled ?? true,
      configured: Boolean(
        (account.addr && (account.mail_pw || account.chatmailQr)) || account.chatmailQr,
      ),
      dataDir: account.dataDir,
      addr: account.addr,
      mail_pw: account.mail_pw,
      bot: account.bot,
      e2ee_enabled: account.e2ee_enabled,
      chatmailQr: account.chatmailQr,
      dm: account.dm,
      groupPolicy: account.groupPolicy,
      groupAllowFrom: account.groupAllowFrom,
      groups: account.groups as DeltaChatAccountConfig["groups"],
      mediaMaxMb: account.mediaMaxMb,
      replyToMode: account.replyToMode,
      initialSyncLimit: account.initialSyncLimit,
      reactionLevel: account.reactionLevel,
      actions: account.actions,
      ackReaction: account.ackReaction,
      ackReactionScope: account.ackReactionScope,
      livenessReactionsEnabled: account.livenessReactionsEnabled,
      livenessReactionIntervalSeconds: account.livenessReactionIntervalSeconds,
    };
    name =
      account.name ??
      account.addr ??
      account.chatmailQr?.split(":")[1] ??
      `Delta.Chat (${resolvedAccountId})`;
    enabled = accountConfig.enabled ?? true;
    configured = accountConfig.configured;
  }

  return {
    accountId: resolvedAccountId,
    name,
    enabled,
    configured,
    config: accountConfig,
  };
}
