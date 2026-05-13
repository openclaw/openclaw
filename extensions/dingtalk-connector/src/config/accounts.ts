import { DEFAULT_ACCOUNT_ID, normalizeAccountId , normalizeResolvedSecretInputString, normalizeSecretInputString } from "../sdk/helpers.ts";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type {
  DingtalkConfig,
  DingtalkAccountConfig,
  DingtalkDefaultAccountSelectionSource,
  ResolvedDingtalkAccount,
} from "../types/index.ts";

/**
 * List all configured account IDs from the accounts field.
 */
function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.["dingtalk-connector"] as DingtalkConfig)?.accounts;
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
    // Backward compatibility: no accounts configured, use default
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolve the default account selection and its source.
 */
export function resolveDefaultDingtalkAccountSelection(cfg: ClawdbotConfig): {
  accountId: string;
  source: DingtalkDefaultAccountSelectionSource;
} {
  const preferredRaw = (cfg.channels?.["dingtalk-connector"] as DingtalkConfig | undefined)?.defaultAccount?.trim();
  const preferred = preferredRaw ? normalizeAccountId(preferredRaw) : undefined;
  if (preferred) {
    return {
      accountId: preferred,
      source: "explicit-default",
    };
  }
  const ids = listDingtalkAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      source: "mapped-default",
    };
  }
  return {
    accountId: ids[0] ?? DEFAULT_ACCOUNT_ID,
    source: "fallback",
  };
}

/**
 * Resolve the default account ID.
 */
export function resolveDefaultDingtalkAccountId(cfg: ClawdbotConfig): string {
  return resolveDefaultDingtalkAccountSelection(cfg).accountId;
}

/**
 * Get the raw account-specific config.
 */
function resolveAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
): DingtalkAccountConfig | undefined {
  const accounts = (cfg.channels?.["dingtalk-connector"] as DingtalkConfig)?.accounts;
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
  const dingtalkCfg = cfg.channels?.["dingtalk-connector"] as DingtalkConfig | undefined;

  // Extract base config (exclude accounts field to avoid recursion)
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...base } = dingtalkCfg ?? {};

  // Get account-specific overrides
  const account = resolveAccountConfig(cfg, accountId) ?? {};

  // Merge: account config overrides base config
  return { ...base, ...account } as DingtalkConfig;
}

/**
 * Resolve DingTalk credentials from a config.
 */
export function resolveDingtalkCredentials(cfg?: DingtalkConfig): {
  clientId: string;
  clientSecret: string;
} | null;
export function resolveDingtalkCredentials(
  cfg: DingtalkConfig | undefined,
  options: { allowUnresolvedSecretRef?: boolean },
): {
  clientId: string;
  clientSecret: string;
} | null;
export function resolveDingtalkCredentials(
  cfg?: DingtalkConfig,
  options?: { allowUnresolvedSecretRef?: boolean },
): {
  clientId: string;
  clientSecret: string;
} | null {
  const normalizeString = (value: unknown): string | undefined => {
    if (typeof value === "number") {
      return String(value);
    }
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };

  const resolveSecretLike = (value: unknown, path: string): string | undefined => {
    // Missing credential: treat as not configured (no exception).
    // This path is used in non-onboarding contexts (e.g. channel listing/status),
    // so we must not throw when credentials are absent.
    if (value === undefined || value === null) {
      return undefined;
    }

    const asString = normalizeString(value);
    if (asString) {
      return asString;
    }

    // In relaxed/onboarding paths only: allow direct env SecretRef reads for UX.
    // Default resolution path must preserve unresolved-ref diagnostics/policy semantics.
    if (options?.allowUnresolvedSecretRef && typeof value === "object" && value !== null) {
      const rec = value as Record<string, unknown>;
      const source = normalizeString(rec.source)?.toLowerCase();
      const id = normalizeString(rec.id);
      if (source === "env" && id) {
        const envValue = normalizeString(process.env[id]);
        if (envValue) {
          return envValue;
        }
      }
    }

    if (options?.allowUnresolvedSecretRef) {
      return normalizeSecretInputString(value);
    }
    return normalizeResolvedSecretInputString({ value, path });
  };

  const clientId = resolveSecretLike(cfg?.clientId, "channels.dingtalk-connector.clientId");
  const clientSecret = resolveSecretLike(cfg?.clientSecret, "channels.dingtalk-connector.clientSecret");

  if (!clientId || !clientSecret) {
    return null;
  }
  return {
    clientId,
    clientSecret,
  };
}

/**
 * Resolve a complete DingTalk account with merged config.
 */
export function resolveDingtalkAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedDingtalkAccount {
  const hasExplicitAccountId =
    typeof params.accountId === "string" && params.accountId.trim() !== "";
  const defaultSelection = hasExplicitAccountId
    ? null
    : resolveDefaultDingtalkAccountSelection(params.cfg);
  const accountId = hasExplicitAccountId
    ? normalizeAccountId(params.accountId ?? "")
    : (defaultSelection?.accountId ?? DEFAULT_ACCOUNT_ID);
  const selectionSource = hasExplicitAccountId
    ? "explicit"
    : (defaultSelection?.source ?? "fallback");
  const dingtalkCfg = params.cfg.channels?.["dingtalk-connector"] as DingtalkConfig | undefined;

  // Base enabled state (top-level)
  const baseEnabled = dingtalkCfg?.enabled !== false;

  // Merge configs
  const merged = mergeDingtalkAccountConfig(params.cfg, accountId);

  // Account-level enabled state
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  // Resolve credentials from merged config
  const creds = resolveDingtalkCredentials(merged);
  const accountName = (merged as DingtalkAccountConfig).name;

  return {
    accountId,
    selectionSource,
    enabled,
    configured: Boolean(creds),
    name: typeof accountName === "string" ? accountName.trim() || undefined : undefined,
    clientId: creds?.clientId,
    clientSecret: creds?.clientSecret,
    config: merged,
  };
}

/**
 * List all enabled and configured accounts.
 * Deduplicates by clientId to avoid creating multiple connections with the same credentials.
 */
export function listEnabledDingtalkAccounts(cfg: ClawdbotConfig): ResolvedDingtalkAccount[] {
  const accounts = listDingtalkAccountIds(cfg)
    .map((accountId) => resolveDingtalkAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
  
  // Deduplicate by clientId to avoid multiple connections with same credentials
  const seen = new Set<string>();
  return accounts.filter((account) => {
    if (!account.clientId) return true;
    if (seen.has(account.clientId)) {
      return false;
    }
    seen.add(account.clientId);
    return true;
  });
}
