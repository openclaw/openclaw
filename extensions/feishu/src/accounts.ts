import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type {
  FeishuConfig,
  FeishuAccountConfig,
  FeishuDomain,
  ResolvedFeishuAccount,
} from "./types.js";
import { createFeishuClient } from "./client.js";

/**
 * List all configured account IDs from the accounts field.
 */
function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.feishu as FeishuConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

/**
 * List all Feishu account IDs.
 * If no accounts are configured, returns [DEFAULT_ACCOUNT_ID] for backward compatibility.
 */
export function listFeishuAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    // Backward compatibility: no accounts configured, use default
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultFeishuAccountId(cfg: ClawdbotConfig): string {
  const ids = listFeishuAccountIds(cfg);
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
): FeishuAccountConfig | undefined {
  const accounts = (cfg.channels?.feishu as FeishuConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

/**
 * Merge top-level config with account-specific config.
 * Account-specific fields override top-level fields.
 */
function mergeFeishuAccountConfig(cfg: ClawdbotConfig, accountId: string): FeishuConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;

  // Extract base config (exclude accounts field to avoid recursion)
  const { accounts: _ignored, ...base } = feishuCfg ?? {};

  // Get account-specific overrides
  const account = resolveAccountConfig(cfg, accountId) ?? {};

  // Merge: account config overrides base config
  return { ...base, ...account } as FeishuConfig;
}

/**
 * Resolve Feishu credentials from a config.
 */
export function resolveFeishuCredentials(cfg?: FeishuConfig): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null {
  const appId = cfg?.appId?.trim();
  const appSecret = cfg?.appSecret?.trim();
  if (!appId || !appSecret) {
    return null;
  }
  return {
    appId,
    appSecret,
    encryptKey: cfg?.encryptKey?.trim() || undefined,
    verificationToken: cfg?.verificationToken?.trim() || undefined,
    domain: cfg?.domain ?? "feishu",
  };
}

/**
 * Resolve a complete Feishu account with merged config.
 */
export function resolveFeishuAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedFeishuAccount {
  const accountId = normalizeAccountId(params.accountId);
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;

  // Base enabled state (top-level)
  const baseEnabled = feishuCfg?.enabled !== false;

  // Merge configs
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);

  // Account-level enabled state
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  // Resolve credentials from merged config
  const creds = resolveFeishuCredentials(merged);

  return {
    accountId,
    enabled,
    configured: Boolean(creds),
    name: (merged as FeishuAccountConfig).name?.trim() || undefined,
    appId: creds?.appId,
    appSecret: creds?.appSecret,
    encryptKey: creds?.encryptKey,
    verificationToken: creds?.verificationToken,
    domain: creds?.domain ?? "feishu",
    config: merged,
  };
}

/**
 * List all enabled and configured accounts.
 */
export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}

/**
 * Resolve a Feishu client for tool execution.
 * If accountId is provided, resolves that specific account.
 * Otherwise falls back to the first enabled account (preserving current behavior).
 */
export function resolveToolClient(
  cfg: ClawdbotConfig,
  accountId?: string,
  preferredAccountId?: string,
) {
  const requested = accountId || preferredAccountId;
  if (requested) {
    const account = resolveFeishuAccount({ cfg, accountId: requested });
    if (!account.configured) {
      throw new Error(`Feishu account "${requested}" is not configured`);
    }
    if (!account.enabled) {
      throw new Error(`Feishu account "${requested}" is disabled`);
    }
    return { client: createFeishuClient(account), accountId: account.accountId, account };
  }
  const accounts = listEnabledFeishuAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No Feishu accounts configured");
  }
  return {
    client: createFeishuClient(accounts[0]),
    accountId: accounts[0].accountId,
    account: accounts[0],
  };
}
