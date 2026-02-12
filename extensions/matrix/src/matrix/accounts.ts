import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, MatrixAccountConfig, MatrixConfig } from "../types.js";
import { resolveMatrixConfig, resolveMatrixConfigForAccount } from "./client.js";
import { credentialsMatchConfig, loadMatrixCredentials, loadMatrixCredentialsForAccount } from "./credentials.js";

export type ResolvedMatrixAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  homeserver?: string;
  userId?: string;
  config: MatrixConfig;
};

export function listMatrixAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.matrix?.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.keys(accounts);
  }
  // Fallback: single default account (backwards compatibility)
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultMatrixAccountId(cfg: CoreConfig): string {
  const ids = listMatrixAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: CoreConfig,
  accountId: string,
): { base: MatrixConfig; accountSpecific?: MatrixAccountConfig; isMultiAccount: boolean } {
  const matrixConfig = cfg.channels?.matrix ?? {};
  const accounts = matrixConfig.accounts;
  
  if (accounts && accountId in accounts) {
    const accountSpecific = accounts[accountId];
    if (accountSpecific) {
      // Merge account-specific config with top-level defaults for backwards compatibility
      return {
        base: matrixConfig,
        accountSpecific,
        isMultiAccount: true,
      };
    }
  }
  
  // Single account mode or default account
  return {
    base: matrixConfig,
    isMultiAccount: false,
  };
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const accountId = normalizeAccountId(params.accountId);
  const { base, accountSpecific, isMultiAccount } = resolveAccountConfig(params.cfg, accountId);
  
  // Determine effective config (account-specific overrides top-level)
  const enabled = isMultiAccount
    ? (accountSpecific?.enabled ?? true)
    : (base.enabled !== false);
    
  const name = isMultiAccount
    ? (accountSpecific?.name?.trim() || accountId)
    : (base.name?.trim() || undefined);
  
  // Resolve config using account-specific or top-level settings
  const resolved = isMultiAccount && accountSpecific
    ? resolveMatrixConfigForAccount(base, accountSpecific, process.env)
    : resolveMatrixConfig(params.cfg, process.env);
    
  const hasHomeserver = Boolean(resolved.homeserver);
  const hasUserId = Boolean(resolved.userId);
  const hasAccessToken = Boolean(resolved.accessToken);
  const hasPassword = Boolean(resolved.password);
  const hasPasswordAuth = hasUserId && hasPassword;
  
  // Load credentials with account-specific path if in multi-account mode
  const stored = isMultiAccount
    ? loadMatrixCredentialsForAccount(accountId, process.env)
    : loadMatrixCredentials(process.env);
    
  const hasStored =
    stored && resolved.homeserver
      ? credentialsMatchConfig(stored, {
          homeserver: resolved.homeserver,
          userId: resolved.userId || "",
        })
      : false;
      
  const configured = hasHomeserver && (hasAccessToken || hasPasswordAuth || Boolean(hasStored));
  
  // Build effective config object
  const effectiveConfig: MatrixConfig = isMultiAccount && accountSpecific
    ? { ...base, ...accountSpecific, accounts: undefined }
    : base;
  
  return {
    accountId,
    enabled,
    name,
    configured,
    homeserver: resolved.homeserver || undefined,
    userId: resolved.userId || undefined,
    config: effectiveConfig,
  };
}

export function listEnabledMatrixAccounts(cfg: CoreConfig): ResolvedMatrixAccount[] {
  return listMatrixAccountIds(cfg)
    .map((accountId) => resolveMatrixAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
