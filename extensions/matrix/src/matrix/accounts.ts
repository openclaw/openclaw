import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, MatrixAccountConfig, MatrixConfig } from "../types.js";
import { resolveMatrixConfig } from "./client.js";
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
  const base = cfg.channels?.matrix ?? {};
  const named =
    base.accounts && typeof base.accounts === "object"
      ? Object.keys(base.accounts).filter(Boolean)
      : [];

  // If base config has credentials (homeserver + accessToken/userId), include "default"
  const hasBaseCredentials = Boolean(base.homeserver && (base.accessToken || base.userId));
  const ids = new Set(named);
  if (hasBaseCredentials) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  return [...ids];
}

export function listMatrixAccountIds(cfg: CoreConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
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

/**
 * Merge base-level matrix config with per-account overrides.
 * Account-level fields (homeserver, userId, accessToken, etc.) take precedence.
 */
export function mergeMatrixAccountConfig(cfg: CoreConfig, accountId: string): MatrixConfig {
  const base = cfg.channels?.matrix ?? {};
  // Strip `accounts` from base so it doesn't leak into merged config
  const { accounts: _ignored, ...baseFields } = base;

  const accountOverrides = base.accounts?.[accountId];
  if (!accountOverrides) {
    return baseFields;
  }

  // Account-level fields override base-level fields
  return { ...baseFields, ...accountOverrides };
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const accountId = normalizeAccountId(params.accountId);
  const base = params.cfg.channels?.matrix ?? {};
  const baseEnabled = base.enabled !== false;

  // Merge base config with per-account overrides
  const merged = mergeMatrixAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const resolved = resolveMatrixConfig(params.cfg, process.env, accountId);
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
    name: merged.name?.trim() || undefined,
    configured,
    homeserver: resolved.homeserver || undefined,
    userId: resolved.userId || undefined,
    config: merged,
  };
}

export function listEnabledMatrixAccounts(cfg: CoreConfig): ResolvedMatrixAccount[] {
  return listMatrixAccountIds(cfg)
    .map((accountId) => resolveMatrixAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
