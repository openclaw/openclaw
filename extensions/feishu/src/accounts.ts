/**
 * Feishu accounts - delegates to core runtime.channel.feishu.
 */
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { getFeishuRuntime } from "./runtime.js";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

const feishu = () => getFeishuRuntime().channel.feishu;

export function listFeishuAccountIds(cfg: ClawdbotConfig): string[] {
  return feishu().listFeishuAccountIds(cfg);
}

export function resolveDefaultFeishuAccountId(cfg: ClawdbotConfig): string {
  return feishu().resolveDefaultFeishuAccountId(cfg);
}

export function resolveFeishuCredentials(cfg?: FeishuConfig): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuConfig["domain"];
} | null {
  if (!cfg) return null;
  const cfgWithChannels = { channels: { feishu: cfg } } as ClawdbotConfig;
  const account = feishu().resolveFeishuAccount({ cfg: cfgWithChannels, accountId: "default" });
  if (!account.configured) return null;
  return {
    appId: account.appId!,
    appSecret: account.appSecret!,
    encryptKey: account.encryptKey,
    verificationToken: account.verificationToken,
    domain: account.domain,
  };
}

export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  return feishu().resolveFeishuAccount(params) as ResolvedFeishuAccount;
}

export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
