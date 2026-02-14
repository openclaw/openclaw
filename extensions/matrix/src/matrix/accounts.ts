import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { resolveMatrixConfigForAccount } from "./client.js";
import { credentialsMatchConfig, loadMatrixCredentials } from "./credentials.js";

/** Merge account config with top-level defaults, preserving nested objects. */
function mergeAccountConfig(base: MatrixConfig, account: MatrixConfig): MatrixConfig {
  const merged = { ...base, ...account };
  // Deep-merge known nested objects so partial overrides inherit base fields
  for (const key of ["dm", "actions"] as const) {
    const b = base[key];
    const o = account[key];
    if (typeof b === "object" && b != null && typeof o === "object" && o != null) {
      (merged as Record<string, unknown>)[key] = { ...b, ...o };
    }
  }
  // Don't propagate the accounts map into the merged per-account config
  delete (merged as Record<string, unknown>).accounts;
  return merged;
}

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
  // Normalize and de-duplicate keys so listing and resolution use the same semantics
  return [
    ...new Set(
      Object.keys(accounts)
        .filter(Boolean)
        .map((id) => normalizeAccountId(id)),
    ),
  ];
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
  // Direct lookup first (fast path for already-normalized keys)
  if (accounts[accountId]) {
    return accounts[accountId] as MatrixConfig;
  }
  // Fall back to case-insensitive match (user may have mixed-case keys in config)
  const normalized = normalizeAccountId(accountId);
  for (const key of Object.keys(accounts)) {
    if (normalizeAccountId(key) === normalized) {
      return accounts[key] as MatrixConfig;
    }
  }
  return undefined;
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const accountId = normalizeAccountId(params.accountId);
  const matrixBase = params.cfg.channels?.matrix ?? {};
  const base = resolveMatrixAccountConfig({ cfg: params.cfg, accountId });
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

export function resolveMatrixAccountConfig(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): MatrixConfig {
  const accountId = normalizeAccountId(params.accountId);
  const matrixBase = params.cfg.channels?.matrix ?? {};
  const accountConfig = resolveAccountConfig(params.cfg, accountId);
  if (!accountConfig) {
    return matrixBase;
  }
  // Merge account-specific config with top-level defaults so settings like
  // groupPolicy and blockStreaming inherit when not overridden.
  return mergeAccountConfig(matrixBase, accountConfig);
}

export function listEnabledMatrixAccounts(cfg: CoreConfig): ResolvedMatrixAccount[] {
  return listMatrixAccountIds(cfg)
    .map((accountId) => resolveMatrixAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
