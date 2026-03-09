import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, QqAccountConfig } from "./types.js";

export type ResolvedQqAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  /** QQ Bot AppID from open platform */
  appId: string;
  /** QQ Bot AppSecret from open platform */
  appSecret: string;
  config: QqAccountConfig;
};

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.qq?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (key.trim()) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

function resolveAccountConfig(cfg: CoreConfig, accountId: string): QqAccountConfig | undefined {
  const accounts = cfg.channels?.qq?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as QqAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as QqAccountConfig | undefined) : undefined;
}

function mergeQqAccountConfig(cfg: CoreConfig, accountId: string): QqAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.qq ?? {}) as QqAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function listQqAccountIds(cfg: CoreConfig): string[] {
  const configured = listConfiguredAccountIds(cfg);
  if (configured.length > 0) {
    return configured;
  }
  // If no explicit accounts, check if base config has appId
  const base = cfg.channels?.qq;
  if (base?.appId || process.env.QQ_APP_ID) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

export function resolveDefaultQqAccountId(cfg: CoreConfig): string {
  const ids = listQqAccountIds(cfg);
  return ids.length > 0 ? ids[0]! : DEFAULT_ACCOUNT_ID;
}

export function resolveQqAccount(params: {
  cfg: CoreConfig;
  accountId?: string;
}): ResolvedQqAccount {
  const { cfg } = params;
  const accountId = normalizeAccountId(params.accountId ?? DEFAULT_ACCOUNT_ID);
  const merged = mergeQqAccountConfig(cfg, accountId);

  // Coerce to string — config may store numbers if set via CLI
  const coerce = (v: unknown): string => (v != null ? String(v).trim() : "");

  // Env var fallbacks for default account
  const appId =
    coerce(merged.appId) ||
    (accountId === DEFAULT_ACCOUNT_ID ? process.env.QQ_APP_ID?.trim() : undefined) ||
    "";

  const appSecret =
    coerce(merged.appSecret) ||
    (accountId === DEFAULT_ACCOUNT_ID ? process.env.QQ_APP_SECRET?.trim() : undefined) ||
    "";

  const enabled = merged.enabled !== false;
  const configured = Boolean(appId && appSecret);

  return {
    accountId,
    enabled,
    name: coerce(merged.name) || undefined,
    configured,
    appId,
    appSecret,
    config: merged,
  };
}
