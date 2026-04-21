import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { CHANNEL_ID } from "./const.js";
import type { WeComConfig, WeComAccountConfig, ResolvedWeComAccount } from "./utils.js";
import { DefaultWsUrl } from "./utils.js";

// ============================================================================
// Multi-account configuration structure
// ============================================================================

/**
 * WeCom multi-account configuration structure (extends WeComConfig)
 */
export interface WeComMultiAccountConfig extends WeComConfig {
  /** Default account ID */
  defaultAccount?: string;
  /** Multi-account configuration */
  accounts?: Record<string, WeComAccountConfig>;
}

// ============================================================================
// Account enumeration
// ============================================================================

/**
 * List all account IDs configured in the accounts field (normalized).
 */
function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.[CHANNEL_ID] as WeComMultiAccountConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean).map(normalizeAccountId);
}

/**
 * Determine whether multi-account mode is active (i.e. the accounts field exists in config).
 * Used for branching between single-account and multi-account modes,
 * replacing the unreliable `accountId === DEFAULT_ACCOUNT_ID` check.
 */
export function hasMultiAccounts(cfg: OpenClawConfig): boolean {
  return listConfiguredAccountIds(cfg).length > 0;
}

/**
 * List all WeCom account IDs.
 * If the accounts field is absent, returns [DEFAULT_ACCOUNT_ID] for backward compatibility.
 */
export function listWeComAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    // Backward compatibility: use default account when accounts is not configured
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a: string, b: string) => a.localeCompare(b));
}

// ============================================================================
// Default account resolution
// ============================================================================

/**
 * Resolve the default account ID.
 *
 * Priority:
 * 1. Explicitly set defaultAccount
 * 2. Account list containing DEFAULT_ACCOUNT_ID
 * 3. First account in alphabetical order
 */
export function resolveDefaultWeComAccountId(cfg: OpenClawConfig): string {
  const wecomConfig = cfg.channels?.[CHANNEL_ID] as WeComMultiAccountConfig | undefined;
  const preferred = wecomConfig?.defaultAccount?.trim();
  if (preferred) {
    return normalizeAccountId(preferred);
  }
  const ids = listWeComAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

// ============================================================================
// Configuration merging
// ============================================================================

/**
 * Merge top-level config with account-level config (account-level overrides top-level).
 *
 * Top-level fields (e.g. dmPolicy, allowFrom) serve as defaults for all accounts.
 * Fields in accounts.xxx override the corresponding top-level fields.
 * For nested object fields like `groups` and `dynamicAgents`, fields are merged
 * shallowly so per-account partial overrides don't erase inherited flags
 * (e.g. setting only `dynamicAgents.adminUsers` at account level must keep
 * top-level `dynamicAgents.enabled`).
 */
function mergeWeComAccountConfig(cfg: OpenClawConfig, accountId: string): WeComConfig {
  const wecomConfig = cfg.channels?.[CHANNEL_ID] as WeComMultiAccountConfig | undefined;

  // Extract base config (exclude accounts and defaultAccount fields to avoid recursion)
  const { accounts: _ignored, defaultAccount: _da, ...base } = wecomConfig ?? {};

  // Find account-level overrides (supports normalized key matching)
  const account = findAccountConfig(wecomConfig?.accounts, accountId);

  // Deep-merge nested object fields by key; account-level override for other fields
  const { groups: baseGroups, dynamicAgents: baseDynamicAgents, ...baseRest } = base;
  const { groups: accountGroups, dynamicAgents: accountDynamicAgents, ...accountRest } = account;

  const mergedGroups =
    baseGroups || accountGroups ? { ...baseGroups, ...accountGroups } : undefined;

  const mergedDynamicAgents =
    baseDynamicAgents || accountDynamicAgents
      ? { ...baseDynamicAgents, ...accountDynamicAgents }
      : undefined;

  return {
    ...baseRest,
    ...accountRest,
    ...(mergedGroups !== undefined ? { groups: mergedGroups } : {}),
    ...(mergedDynamicAgents !== undefined ? { dynamicAgents: mergedDynamicAgents } : {}),
  } as WeComConfig;
}

/**
 * Find config in the accounts Record by normalized accountId.
 * Prevents lookup failures due to case differences.
 */
function findAccountConfig(
  accounts: Record<string, WeComAccountConfig> | undefined,
  accountId: string,
): WeComAccountConfig {
  if (!accounts) {
    return {};
  }
  // Exact match first
  if (accounts[accountId]) {
    return accounts[accountId];
  }
  // Match after normalization
  const normalized = normalizeAccountId(accountId);
  for (const [key, value] of Object.entries(accounts)) {
    if (normalizeAccountId(key) === normalized) {
      return value;
    }
  }
  return {};
}

// ============================================================================
// Account resolution
// ============================================================================

/**
 * Resolve the full configuration for a single WeCom account.
 *
 * Supports:
 * - Explicit accountId → uses that accountId
 * - No accountId specified → uses the default account
 * - Single-account mode (no accounts field) → reads top-level config directly
 */
export function resolveWeComAccountMulti(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWeComAccount {
  const hasExplicitId = typeof params.accountId === "string" && params.accountId.trim() !== "";
  const accountId = hasExplicitId
    ? normalizeAccountId(params.accountId)
    : resolveDefaultWeComAccountId(params.cfg);

  const wecomConfig = params.cfg.channels?.[CHANNEL_ID] as WeComMultiAccountConfig | undefined;

  // Top-level enabled state
  const baseEnabled = wecomConfig?.enabled !== false;

  // Merge config
  const merged = mergeWeComAccountConfig(params.cfg, accountId);

  // Account-level enabled state
  const accountEnabled = merged.enabled !== false;

  return {
    accountId,
    name: merged.name ?? "企业微信",
    enabled: baseEnabled && accountEnabled,
    websocketUrl: merged.websocketUrl || DefaultWsUrl,
    botId: merged.botId ?? "",
    // Normalize SecretInput → string; unresolved SecretRef becomes "" (treated as "not available").
    secret: normalizeSecretInputString(merged.secret) ?? "",
    sendThinkingMessage: merged.sendThinkingMessage ?? true,
    config: merged,
  };
}

// ============================================================================
// Batch queries
// ============================================================================

/**
 * List all enabled accounts that have configured credentials.
 */
export function listEnabledWeComAccounts(cfg: OpenClawConfig): ResolvedWeComAccount[] {
  return listWeComAccountIds(cfg)
    .map((accountId) => resolveWeComAccountMulti({ cfg, accountId }))
    .filter((account) => {
      if (!account.enabled) {
        return false;
      }
      return Boolean(account.botId?.trim() && account.secret?.trim());
    });
}

// ============================================================================
// Config write (multi-account aware)
// ============================================================================

/**
 * Write WeCom account configuration (automatically distinguishes single/multi-account mode).
 *
 * - Single-account mode (no accounts field): writes to top-level channels.wecom
 * - Multi-account mode: writes to channels.wecom.accounts[accountId]
 *
 * @param cfg  Current global configuration
 * @param updates  Partial config fields to write
 * @param accountId  Target account ID (defaults to the default account)
 */
export function setWeComAccountMulti(
  cfg: OpenClawConfig,
  updates: Partial<WeComConfig>,
  accountId?: string,
): OpenClawConfig {
  const resolvedAccountId = accountId ?? resolveDefaultWeComAccountId(cfg);
  const isMulti = hasMultiAccounts(cfg);

  if (!isMulti) {
    // Single-account mode: merge into top-level
    const existing = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComConfig;
    const merged: WeComConfig = { ...existing, ...updates };
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [CHANNEL_ID]: merged,
      },
    };
  }

  // Multi-account mode: merge into accounts[accountId]
  const wecomConfig = (cfg.channels?.[CHANNEL_ID] ?? {}) as WeComMultiAccountConfig;
  const existingAccount = wecomConfig.accounts?.[resolvedAccountId] ?? {};
  const mergedAccount: WeComAccountConfig = { ...existingAccount, ...updates };

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [CHANNEL_ID]: {
        ...wecomConfig,
        accounts: {
          ...wecomConfig.accounts,
          [resolvedAccountId]: mergedAccount,
        },
      },
    },
  };
}
