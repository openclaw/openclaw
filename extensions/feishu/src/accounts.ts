import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";
import type {
  FeishuConfig,
  FeishuAccountConfig,
  FeishuAccountSelectionSource,
  FeishuDefaultAccountSelectionSource,
  FeishuDomain,
  ResolvedFeishuAccount,
} from "./types.js";

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
 * Resolve the default account selection and its source.
 */
export function resolveDefaultFeishuAccountSelection(cfg: ClawdbotConfig): {
  accountId: string;
  source: FeishuDefaultAccountSelectionSource;
} {
  const preferredRaw = (cfg.channels?.feishu as FeishuConfig | undefined)?.defaultAccount?.trim();
  const preferred = preferredRaw ? normalizeAccountId(preferredRaw) : undefined;
  if (preferred) {
    return {
      accountId: preferred,
      source: "explicit-default",
    };
  }
  const ids = listFeishuAccountIds(cfg);
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
export function resolveDefaultFeishuAccountId(cfg: ClawdbotConfig): string {
  return resolveDefaultFeishuAccountSelection(cfg).accountId;
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
  const { accounts: _ignored, defaultAccount: _ignoredDefaultAccount, ...base } = feishuCfg ?? {};

  // Get account-specific overrides
  const account = resolveAccountConfig(cfg, accountId) ?? {};

  // Merge: account config overrides base config
  return { ...base, ...account } as FeishuConfig;
}

function resolveFeishuAccountConfigState(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): {
  accountId: string;
  selectionSource: FeishuAccountSelectionSource;
  enabled: boolean;
  configured: boolean;
  name?: string;
  domain: FeishuDomain;
  config: FeishuConfig;
} {
  const hasExplicitAccountId =
    typeof params.accountId === "string" && params.accountId.trim() !== "";
  const defaultSelection = hasExplicitAccountId
    ? null
    : resolveDefaultFeishuAccountSelection(params.cfg);
  const accountId = hasExplicitAccountId
    ? normalizeAccountId(params.accountId)
    : (defaultSelection?.accountId ?? DEFAULT_ACCOUNT_ID);
  const selectionSource: FeishuAccountSelectionSource = hasExplicitAccountId
    ? "explicit"
    : (defaultSelection?.source ?? "fallback");
  const feishuCfg = params.cfg.channels?.feishu as FeishuConfig | undefined;

  const baseEnabled = feishuCfg?.enabled !== false;
  const merged = mergeFeishuAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const configured = Boolean(
    hasConfiguredSecretInput(merged.appId) && hasConfiguredSecretInput(merged.appSecret),
  );
  const accountName = (merged as FeishuAccountConfig).name;

  return {
    accountId,
    selectionSource,
    enabled,
    configured,
    name: typeof accountName === "string" ? accountName.trim() || undefined : undefined,
    domain: merged.domain ?? "feishu",
    config: merged,
  };
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
} | null;
export function resolveFeishuCredentials(
  cfg: FeishuConfig | undefined,
  options: { allowUnresolvedSecretRef?: boolean },
): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null;
export function resolveFeishuCredentials(
  cfg?: FeishuConfig,
  options?: { allowUnresolvedSecretRef?: boolean },
): {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  domain: FeishuDomain;
} | null {
  const normalizeString = (value: unknown): string | undefined => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };

  const resolveSecretLike = (value: unknown, path: string): string | undefined => {
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

  const appId = resolveSecretLike(cfg?.appId, "channels.feishu.appId");
  const appSecret = resolveSecretLike(cfg?.appSecret, "channels.feishu.appSecret");

  if (!appId || !appSecret) {
    return null;
  }
  const connectionMode = cfg?.connectionMode ?? "websocket";
  return {
    appId,
    appSecret,
    encryptKey:
      connectionMode === "webhook"
        ? resolveSecretLike(cfg?.encryptKey, "channels.feishu.encryptKey")
        : normalizeString(cfg?.encryptKey),
    verificationToken: resolveSecretLike(
      cfg?.verificationToken,
      "channels.feishu.verificationToken",
    ),
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
  const state = resolveFeishuAccountConfigState(params);
  const creds = resolveFeishuCredentials(state.config);

  return {
    accountId: state.accountId,
    selectionSource: state.selectionSource,
    enabled: state.enabled,
    configured: Boolean(creds),
    name: state.name,
    appId: creds?.appId,
    appSecret: creds?.appSecret,
    encryptKey: creds?.encryptKey,
    verificationToken: creds?.verificationToken,
    domain: creds?.domain ?? state.domain,
    config: state.config,
  };
}

/**
 * List all enabled accounts that appear configured from raw config input alone.
 * This preflight path intentionally does not resolve SecretRefs.
 */
export function listEnabledFeishuAccountConfigs(cfg: ClawdbotConfig): Array<{
  accountId: string;
  selectionSource: FeishuAccountSelectionSource;
  enabled: boolean;
  configured: boolean;
  name?: string;
  domain: FeishuDomain;
  config: FeishuConfig;
}> {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccountConfigState({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}

/**
 * List all enabled and configured accounts.
 */
export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
  return listFeishuAccountIds(cfg)
    .map((accountId) => resolveFeishuAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
