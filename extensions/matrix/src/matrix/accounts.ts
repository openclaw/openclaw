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
  config: MatrixAccountConfig;
};

// ---------------------------------------------------------------------------
// Account ID listing
// ---------------------------------------------------------------------------

/**
 * Collect account IDs from `channels.matrix.accounts` config keys.
 * Returns an empty array when no `accounts` map is present.
 */
function listConfiguredAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.matrix?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).map((k) => normalizeAccountId(k));
}

/**
 * Collect account IDs referenced in `cfg.bindings` for the matrix channel.
 */
function listMatrixBoundAccountIds(cfg: CoreConfig): string[] {
  const bindings = cfg.bindings;
  if (!Array.isArray(bindings)) {
    return [];
  }
  const ids = new Set<string>();
  for (const binding of bindings) {
    const channel = binding?.match?.channel;
    if (typeof channel !== "string" || channel.toLowerCase() !== "matrix") {
      continue;
    }
    const accountId = binding?.match?.accountId;
    if (typeof accountId !== "string" || !accountId.trim() || accountId === "*") {
      continue;
    }
    ids.add(normalizeAccountId(accountId));
  }
  return [...ids];
}

/**
 * Return all known Matrix account IDs (config + bindings, deduplicated).
 * Falls back to `[DEFAULT_ACCOUNT_ID]` when none are found.
 */
export function listMatrixAccountIds(cfg: CoreConfig): string[] {
  const ids = new Set([...listConfiguredAccountIds(cfg), ...listMatrixBoundAccountIds(cfg)]);
  if (ids.size === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// Default account
// ---------------------------------------------------------------------------

export function resolveDefaultMatrixAccountId(cfg: CoreConfig): string {
  const ids = listMatrixAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

// ---------------------------------------------------------------------------
// Config merging (base + per-account overlay)
// ---------------------------------------------------------------------------

/**
 * Merge the base Matrix config (top-level fields minus `accounts`) with
 * per-account overrides from `channels.matrix.accounts[accountId]`.
 */
export function mergeMatrixAccountConfig(cfg: CoreConfig, accountId: string): MatrixAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.matrix ?? {}) as MatrixConfig & {
    accounts?: unknown;
  };
  const normalized = normalizeAccountId(accountId);
  const perAccount = cfg.channels?.matrix?.accounts?.[normalized] ?? {};
  return { ...base, ...perAccount };
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeMatrixAccountConfig(params.cfg, accountId);
  const enabled = merged.enabled !== false;

  // Env vars are only used for the default account.
  const env = accountId === DEFAULT_ACCOUNT_ID ? process.env : {};
  const resolved = resolveMatrixConfig(merged, env);

  const hasHomeserver = Boolean(resolved.homeserver);
  const hasAccessToken = Boolean(resolved.accessToken);
  const hasUserId = Boolean(resolved.userId);
  const hasPassword = Boolean(resolved.password);
  const hasPasswordAuth = hasUserId && hasPassword;

  const stored = loadMatrixCredentials(
    accountId === DEFAULT_ACCOUNT_ID ? process.env : {},
    accountId,
  );
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
