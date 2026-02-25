import type { ActiviConfig } from "activi/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "activi/plugin-sdk/account-id";
import { resolveZaloToken } from "./token.js";
import type { ResolvedZaloAccount, ZaloAccountConfig, ZaloConfig } from "./types.js";

export type { ResolvedZaloAccount };

function listConfiguredAccountIds(cfg: ActiviConfig): string[] {
  const accounts = (cfg.channels?.zalo as ZaloConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listZaloAccountIds(cfg: ActiviConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultZaloAccountId(cfg: ActiviConfig): string {
  const zaloConfig = cfg.channels?.zalo as ZaloConfig | undefined;
  if (zaloConfig?.defaultAccount?.trim()) {
    return zaloConfig.defaultAccount.trim();
  }
  const ids = listZaloAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: ActiviConfig,
  accountId: string,
): ZaloAccountConfig | undefined {
  const accounts = (cfg.channels?.zalo as ZaloConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZaloAccountConfig | undefined;
}

function mergeZaloAccountConfig(cfg: ActiviConfig, accountId: string): ZaloAccountConfig {
  const raw = (cfg.channels?.zalo ?? {}) as ZaloConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveZaloAccount(params: {
  cfg: ActiviConfig;
  accountId?: string | null;
}): ResolvedZaloAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.zalo as ZaloConfig | undefined)?.enabled !== false;
  const merged = mergeZaloAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const tokenResolution = resolveZaloToken(
    params.cfg.channels?.zalo as ZaloConfig | undefined,
    accountId,
  );

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}

export function listEnabledZaloAccounts(cfg: ActiviConfig): ResolvedZaloAccount[] {
  return listZaloAccountIds(cfg)
    .map((accountId) => resolveZaloAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
