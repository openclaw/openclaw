import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { ZulipAccountConfig } from "../types.js";
import { normalizeZulipBaseUrl } from "./client.js";

export type ResolvedZulipAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl?: string;
  email?: string;
  apiKey?: string;
  config: ZulipAccountConfig;
};

type ZulipChannelConfig = { accounts?: Record<string, unknown> };

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.zulip as ZulipChannelConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listZulipAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultZulipAccountId(cfg: OpenClawConfig): string {
  const ids = listZulipAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): ZulipAccountConfig | undefined {
  const accounts = (cfg.channels?.zulip as ZulipChannelConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as ZulipAccountConfig | undefined;
}

function mergeZulipAccountConfig(cfg: OpenClawConfig, accountId: string): ZulipAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.zulip ?? {}) as ZulipAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

export function resolveZulipAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedZulipAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = params.cfg.channels?.zulip?.enabled !== false;
  const merged = mergeZulipAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envRealm = allowEnv ? process.env.ZULIP_REALM?.trim() : undefined;
  const envSite = allowEnv ? process.env.ZULIP_SITE?.trim() : undefined;
  const envEmail = allowEnv ? process.env.ZULIP_EMAIL?.trim() : undefined;
  const envApiKey = allowEnv ? process.env.ZULIP_API_KEY?.trim() : undefined;

  const configRealm = merged.realm?.trim();
  const configSite = merged.site?.trim();
  const configEmail = merged.email?.trim();
  const configApiKey = merged.apiKey?.trim();

  const baseUrl = normalizeZulipBaseUrl(configSite || configRealm || envSite || envRealm);

  return {
    accountId,
    enabled,
    name: merged.name?.trim() || undefined,
    baseUrl,
    email: configEmail || envEmail,
    apiKey: configApiKey || envApiKey,
    config: merged,
  };
}

export function listEnabledZulipAccounts(cfg: OpenClawConfig): ResolvedZulipAccount[] {
  return listZulipAccountIds(cfg)
    .map((accountId) => resolveZulipAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
