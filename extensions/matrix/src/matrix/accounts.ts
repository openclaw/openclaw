import {
  resolveConfiguredMatrixAccountIds,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../account-selection.js";
import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  normalizeAccountId,
} from "../runtime-api.js";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { findMatrixAccountConfig, resolveMatrixBaseConfig } from "./account-config.js";
import { resolveMatrixConfigForAccount } from "./client.js";
import { credentialsMatchConfig, loadMatrixCredentials } from "./credentials-read.js";

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

function resolveMatrixAccountUserId(params: {
  cfg: CoreConfig;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): string | null {
  const env = params.env ?? process.env;
  const resolved = resolveMatrixConfigForAccount(params.cfg, params.accountId, env);
  const configuredUserId = resolved.userId.trim();
  if (configuredUserId) {
    return configuredUserId;
  }

  const stored = loadMatrixCredentials(env, params.accountId);
  if (!stored) {
    return null;
  }
  if (resolved.homeserver && stored.homeserver !== resolved.homeserver) {
    return null;
  }
  if (resolved.accessToken && stored.accessToken !== resolved.accessToken) {
    return null;
  }
  return stored.userId.trim() || null;
}

export function listMatrixAccountIds(cfg: CoreConfig): string[] {
  const ids = resolveConfiguredMatrixAccountIds(cfg, process.env);
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultMatrixAccountId(cfg: CoreConfig): string {
  return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg));
}

export function resolveConfiguredMatrixBotUserIds(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  env?: NodeJS.ProcessEnv;
}): Set<string> {
  const env = params.env ?? process.env;
  const currentAccountId = normalizeAccountId(params.accountId);
  const accountIds = new Set(resolveConfiguredMatrixAccountIds(params.cfg, env));
  if (resolveMatrixAccount({ cfg: params.cfg, accountId: DEFAULT_ACCOUNT_ID }).configured) {
    accountIds.add(DEFAULT_ACCOUNT_ID);
  }
  const ids = new Set<string>();

  for (const accountId of accountIds) {
    if (normalizeAccountId(accountId) === currentAccountId) {
      continue;
    }
    if (!resolveMatrixAccount({ cfg: params.cfg, accountId }).configured) {
      continue;
    }
    const userId = resolveMatrixAccountUserId({
      cfg: params.cfg,
      accountId,
      env,
    });
    if (userId) {
      ids.add(userId);
    }
  }

  return ids;
}

export function resolveMatrixAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedMatrixAccount {
  const accountId = normalizeAccountId(params.accountId);
  const matrixBase = resolveMatrixBaseConfig(params.cfg);
  const base = resolveMatrixAccountConfig({ cfg: params.cfg, accountId });
  const enabled = base.enabled !== false && matrixBase.enabled !== false;

  const resolved = resolveMatrixConfigForAccount(params.cfg, accountId, process.env);
  const hasHomeserver = Boolean(resolved.homeserver);
  const hasUserId = Boolean(resolved.userId);
  const hasAccessToken = Boolean(resolved.accessToken);
  const hasPassword = Boolean(resolved.password);
  const hasPasswordAuth = hasUserId && (hasPassword || hasConfiguredSecretInput(base.password));
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
  const matrixBase = resolveMatrixBaseConfig(params.cfg);
  const accountConfig = findMatrixAccountConfig(params.cfg, accountId);
  if (!accountConfig) {
    return matrixBase;
  }
  // Merge account-specific config with top-level defaults so settings like
  // groupPolicy and blockStreaming inherit when not overridden.
  return mergeAccountConfig(matrixBase, accountConfig);
}
