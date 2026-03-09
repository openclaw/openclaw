import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { CoreConfig, WechatAccountConfig } from "./types.js";

const DEFAULT_PUPPET = "wechaty-puppet-wechat4";

export type ResolvedWechatAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  puppet: string;
  puppetOptions: Record<string, unknown>;
  config: WechatAccountConfig;
};

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.wechat?.accounts;
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

function resolveAccountConfig(cfg: CoreConfig, accountId: string): WechatAccountConfig | undefined {
  const accounts = cfg.channels?.wechat?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  const direct = accounts[accountId] as WechatAccountConfig | undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as WechatAccountConfig | undefined) : undefined;
}

function mergeWechatAccountConfig(cfg: CoreConfig, accountId: string): WechatAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.wechat ?? {}) as WechatAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function listWechatAccountIds(cfg: CoreConfig): string[] {
  const configured = listConfiguredAccountIds(cfg);
  if (configured.length > 0) {
    return configured;
  }
  // WeChat (Wechaty) is always "configurable" — it uses QR login, not a static token
  const base = cfg.channels?.wechat;
  if (base) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

export function resolveDefaultWechatAccountId(cfg: CoreConfig): string {
  const ids = listWechatAccountIds(cfg);
  return ids.length > 0 ? ids[0]! : DEFAULT_ACCOUNT_ID;
}

export function resolveWechatAccount(params: {
  cfg: CoreConfig;
  accountId?: string;
}): ResolvedWechatAccount {
  const { cfg } = params;
  const accountId = normalizeAccountId(params.accountId ?? DEFAULT_ACCOUNT_ID);
  const merged = mergeWechatAccountConfig(cfg, accountId);

  // Coerce to string — config may store unexpected types if set via CLI
  const coerce = (v: unknown): string => (v != null ? String(v).trim() : "");

  const puppet = coerce(merged.puppet) || DEFAULT_PUPPET;
  const puppetOptions = merged.puppetOptions ?? {};
  const enabled = merged.enabled !== false;
  // Wechaty is "configured" as long as the channel section exists; login happens via QR at runtime
  const configured = cfg.channels?.wechat !== undefined;

  return {
    accountId,
    enabled,
    name: coerce(merged.name) || undefined,
    configured,
    puppet,
    puppetOptions,
    config: merged,
  };
}
