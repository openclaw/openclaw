import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { resolveMatrixConfigForAccount } from "./client.js";
import { credentialsMatchConfig, loadMatrixCredentials } from "./credentials.js";

export type ResolvedMatrixAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  homeserver?: string;
  userId?: string;
  config: MatrixConfig;
};

function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.matrix?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listMatrixAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    // Fall back to default if no accounts configured (legacy top-level config)
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultMatrixAccountId(cfg: CoreConfig): string {
  const ids = listMatrixAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: CoreConfig, accountId: string): MatrixConfig | undefined {
  const accounts = cfg.channels?.matrix?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId] as MatrixConfig | undefined;
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const accountId = normalizeAccountId(params.accountId);
  const matrixBase = params.cfg.channels?.matrix ?? {};

  // Check if this account exists in accounts structure
  const accountConfig = resolveAccountConfig(params.cfg, accountId);

  // Use account-specific config if available, otherwise fall back to top-level
  const base: MatrixConfig = accountConfig ?? matrixBase;
  const enabled = base.enabled !== false && matrixBase.enabled !== false;

  const resolved = resolveMatrixConfigForAccount(params.cfg, accountId, process.env);
  const hasHomeserver = Boolean(resolved.homeserver);
  const hasUserId = Boolean(resolved.userId);
  const hasAccessToken = Boolean(resolved.accessToken);
  const hasPassword = Boolean(resolved.password);
  const hasPasswordAuth = hasUserId && hasPassword;
  const stored = loadMatrixCredentials(process.env, accountId);
  const hasStored =
    stored && resolved.homeserver
      ? credentialsMatchConfig(stored, {
          homeserver: resolved.homeserver,
          userId: resolved.userId || "",
        })
      : false;
  const configured = hasHomeserver && (hasAccessToken || hasPasswordAuth || Boolean(hasStored));
  return {
    accountId,
    enabled,
    name: base.name?.trim() || undefined,
    configured,
    homeserver: resolved.homeserver || undefined,
    userId: resolved.userId || undefined,
    config: base,
  };
}

export function listEnabledMatrixAccounts(cfg: CoreConfig): ResolvedMatrixAccount[] {
  return listMatrixAccountIds(cfg)
    .map((accountId) => resolveMatrixAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
