import type { ClawdbotConfig } from "openclaw/plugin-sdk/dingtalk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/dingtalk";
import type { DingtalkConfig, DingtalkAccountConfig, ResolvedDingtalkAccount } from "./types.js";

/**
 * List all configured account IDs from the accounts field.
 */
function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.dingtalk as DingtalkConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

/**
 * List all DingTalk account IDs.
 * If no accounts are configured, returns [DEFAULT_ACCOUNT_ID] for backward compatibility.
 */
export function listDingtalkAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultDingtalkAccountId(cfg: ClawdbotConfig): string {
  const ids = listDingtalkAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Get the raw account-specific config.
 */
function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): DingtalkAccountConfig | undefined {
  const accounts = (cfg.channels?.dingtalk as DingtalkConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

/**
 * Merge top-level config with account-specific config.
 * Account-specific fields override top-level fields.
 */
function mergeDingtalkAccountConfig(cfg: ClawdbotConfig, accountId: string): DingtalkConfig {
  const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;
  const { accounts: _ignored, ...base } = dingtalkCfg ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as DingtalkConfig;
}

/**
 * Resolve DingTalk credentials from a config.
 */
export function resolveDingtalkCredentials(cfg?: DingtalkConfig): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = cfg?.clientId?.trim();
  const clientSecret = cfg?.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

/**
 * Resolve a complete DingTalk account with merged config.
 */
export function resolveDingtalkAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedDingtalkAccount {
  const accountId = normalizeAccountId(params.accountId);
  const dingtalkCfg = params.cfg.channels?.dingtalk as DingtalkConfig | undefined;

  const baseEnabled = dingtalkCfg?.enabled !== false;
  const merged = mergeDingtalkAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const creds = resolveDingtalkCredentials(merged);

  return {
    accountId,
    enabled,
    configured: Boolean(creds),
    name: (merged as DingtalkAccountConfig).name?.trim() || undefined,
    clientId: creds?.clientId,
    clientSecret: creds?.clientSecret,
    config: merged,
  };
}

/**
 * List all enabled and configured accounts.
 */
export function listEnabledDingtalkAccounts(cfg: ClawdbotConfig): ResolvedDingtalkAccount[] {
  return listDingtalkAccountIds(cfg)
    .map((accountId) => resolveDingtalkAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
