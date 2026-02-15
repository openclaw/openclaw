import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ResolvedTuituiAccount, TuituiAccountConfig, TuituiConfig } from "./types.js";
import { resolveTuituiCredentials } from "./credentials.js";

export type { ResolvedTuituiAccount };

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.tuitui as TuituiConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listTuituiAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultTuituiAccountId(cfg: OpenClawConfig): string {
  const c = cfg.channels?.tuitui as TuituiConfig | undefined;
  if (c?.defaultAccount?.trim()) {
    return c.defaultAccount.trim();
  }
  const ids = listTuituiAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TuituiAccountConfig | undefined {
  const accounts = (cfg.channels?.tuitui as TuituiConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as TuituiAccountConfig | undefined;
}

function mergeTuituiAccountConfig(cfg: OpenClawConfig, accountId: string): TuituiAccountConfig {
  const raw = (cfg.channels?.tuitui ?? {}) as TuituiConfig;
  const { accounts: _a, defaultAccount: _b, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveTuituiAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTuituiAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.tuitui as TuituiConfig | undefined)?.enabled !== false;
  const merged = mergeTuituiAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const creds = resolveTuituiCredentials(
    params.cfg.channels?.tuitui as TuituiConfig | undefined,
    accountId,
  );

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    appId: creds.appId,
    secret: creds.secret,
    credentialsSource: creds.source,
    config: merged,
  };
}

export function listEnabledTuituiAccounts(cfg: OpenClawConfig): ResolvedTuituiAccount[] {
  return listTuituiAccountIds(cfg)
    .map((accountId) => resolveTuituiAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

/** 按 appId 查找已配置的账户（用于 webhook 按 X-Tuitui-Robot-Appid 分发） */
export function resolveTuituiAccountByAppId(
  cfg: OpenClawConfig,
  appId: string,
): ResolvedTuituiAccount | null {
  const id = appId?.trim();
  if (!id) return null;
  for (const accountId of listTuituiAccountIds(cfg)) {
    const account = resolveTuituiAccount({ cfg, accountId });
    if (account.appId === id && account.secret) return account;
  }
  return null;
}
