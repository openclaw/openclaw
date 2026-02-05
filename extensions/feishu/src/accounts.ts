import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { FeishuConfig, FeishuDomain, ResolvedFeishuAccount } from "./types.js";

export function resolveFeishuCredentials(cfg?: FeishuConfig): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null {
  const appId = cfg?.appId?.trim();
  const appSecret = cfg?.appSecret?.trim();
  if (!appId || !appSecret) return null;
  return {
    appId,
    appSecret,
    encryptKey: cfg?.encryptKey?.trim() || undefined,
    verificationToken: cfg?.verificationToken?.trim() || undefined,
    domain: cfg?.domain ?? "feishu",
  };
}

export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;
  const enabled = feishuCfg?.enabled !== false;
  const creds = resolveFeishuCredentials(feishuCfg);

  return {
    accountId: params.accountId?.trim() || DEFAULT_ACCOUNT_ID,
    enabled,
    configured: Boolean(creds),
    appId: creds?.appId,
    domain: creds?.domain ?? "feishu",
  };
}

export function listFeishuAccountIds(_cfg: ClawdbotConfig): string[] {
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultFeishuAccountId(_cfg: ClawdbotConfig): string {
  return DEFAULT_ACCOUNT_ID;
}

export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
