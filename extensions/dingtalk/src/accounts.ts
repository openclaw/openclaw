import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/dingtalk";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "./secret-input.js";
import type {
  DingtalkConfig,
  DingtalkAccountConfig,
  DingtalkDefaultAccountSelectionSource,
  ResolvedDingtalkAccount,
} from "./types.js";

/**
 * 列出所有已配置的账号 ID / List all configured account IDs
 */
function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.dingtalk as DingtalkConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

/**
 * 列出所有钉钉账号 ID / List all DingTalk account IDs
 * 如果没有配置多账号，返回默认账号 / Returns default account if no accounts configured
 */
export function listDingtalkAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

/**
 * 解析默认账号及其来源 / Resolve default account selection and its source
 */
export function resolveDefaultDingtalkAccountSelection(cfg: ClawdbotConfig): {
  accountId: string;
  source: DingtalkDefaultAccountSelectionSource;
} {
  const preferredRaw = (
    cfg.channels?.dingtalk as DingtalkConfig | undefined
  )?.defaultAccount?.trim();
  const preferred = preferredRaw ? normalizeAccountId(preferredRaw) : undefined;
  if (preferred) {
    const ids = listDingtalkAccountIds(cfg);
    if (ids.includes(preferred) || preferred === DEFAULT_ACCOUNT_ID) {
      return { accountId: preferred, source: "explicit-default" };
    }
    // defaultAccount points to a non-existent account; fall through to auto-selection
  }
  const ids = listDingtalkAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return { accountId: DEFAULT_ACCOUNT_ID, source: "mapped-default" };
  }
  return { accountId: ids[0] ?? DEFAULT_ACCOUNT_ID, source: "fallback" };
}

/**
 * 解析默认账号 ID / Resolve the default account ID
 */
export function resolveDefaultDingtalkAccountId(cfg: ClawdbotConfig): string {
  return resolveDefaultDingtalkAccountSelection(cfg).accountId;
}

/**
 * 获取账号级别的原始配置 / Get raw account-specific config
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
 * 合并顶层配置与账号级别配置 / Merge top-level config with account-specific config
 */
function mergeDingtalkAccountConfig(cfg: ClawdbotConfig, accountId: string): DingtalkConfig {
  const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;
  const { accounts: _ignored, defaultAccount: _ignoredDefault, ...base } = dingtalkCfg ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as DingtalkConfig;
}

/**
 * 解析钉钉凭证 / Resolve DingTalk credentials from config
 */
export function resolveDingtalkCredentials(
  cfg?: DingtalkConfig,
  options?: { allowUnresolvedSecretRef?: boolean },
): {
  clientId: string;
  clientSecret: string;
  robotCode: string;
} | null {
  const normalizeString = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
  };

  const resolveSecretLike = (value: unknown, path: string): string | undefined => {
    const asString = normalizeString(value);
    if (asString) return asString;

    if (options?.allowUnresolvedSecretRef && typeof value === "object" && value !== null) {
      const rec = value as Record<string, unknown>;
      const source = normalizeString(rec.source)?.toLowerCase();
      const id = normalizeString(rec.id);
      if (source === "env" && id) {
        const envValue = normalizeString(process.env[id]);
        if (envValue) return envValue;
      }
    }

    if (options?.allowUnresolvedSecretRef) {
      return normalizeSecretInputString(value);
    }
    return normalizeResolvedSecretInputString({ value, path });
  };

  const clientId = resolveSecretLike(cfg?.clientId, "channels.dingtalk.clientId");
  const clientSecret = resolveSecretLike(cfg?.clientSecret, "channels.dingtalk.clientSecret");

  if (!clientId || !clientSecret) {
    return null;
  }

  // robotCode 默认等于 clientId / robotCode defaults to clientId
  const robotCode = normalizeString(cfg?.robotCode) ?? clientId;

  return { clientId, clientSecret, robotCode };
}

/**
 * 解析完整的钉钉账号 / Resolve a complete DingTalk account with merged config
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
    ? normalizeAccountId(params.accountId)
    : (defaultSelection?.accountId ?? DEFAULT_ACCOUNT_ID);
  const selectionSource = hasExplicitAccountId
    ? "explicit"
    : (defaultSelection?.source ?? "fallback");
  const dingtalkCfg = params.cfg.channels?.dingtalk as DingtalkConfig | undefined;

  const baseEnabled = dingtalkCfg?.enabled !== false;
  const merged = mergeDingtalkAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

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
    robotCode: creds?.robotCode,
    config: merged,
  };
}

/**
 * 列出所有已启用且已配置的账号 / List all enabled and configured accounts
 */
export function listEnabledDingtalkAccounts(cfg: ClawdbotConfig): ResolvedDingtalkAccount[] {
  return listDingtalkAccountIds(cfg)
    .map((accountId) => resolveDingtalkAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
