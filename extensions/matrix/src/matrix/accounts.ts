import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  resolveConfiguredMatrixAccountIds,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../account-selection.js";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { findMatrixAccountConfig, resolveMatrixBaseConfig } from "./account-config.js";
import { resolveMatrixConfigForAccount } from "./client.js";
import { credentialsMatchConfig, loadMatrixCredentials } from "./credentials-read.js";

type MatrixRoomEntries = Record<string, NonNullable<MatrixConfig["groups"]>[string]>;

function selectInheritedMatrixRoomEntries(params: {
  entries: MatrixRoomEntries | undefined;
  accountId: string;
}): MatrixRoomEntries | undefined {
  const entries = params.entries;
  if (!entries) {
    return undefined;
  }
  const selected = Object.fromEntries(
    Object.entries(entries).filter(([, value]) => {
      const scopedAccount =
        typeof value?.account === "string" ? normalizeAccountId(value.account) : undefined;
      return scopedAccount === undefined || scopedAccount === params.accountId;
    }),
  ) as MatrixRoomEntries;
  return Object.keys(selected).length > 0 ? selected : undefined;
}

function mergeMatrixRoomEntries(
  inherited: MatrixRoomEntries | undefined,
  accountEntries: MatrixRoomEntries | undefined,
  hasAccountOverride: boolean,
): MatrixRoomEntries | undefined {
  if (!inherited && !accountEntries) {
    return undefined;
  }
  if (hasAccountOverride && Object.keys(accountEntries ?? {}).length === 0) {
    return undefined;
  }
  const merged: MatrixRoomEntries = {
    ...(inherited ?? {}),
  };
  for (const [key, value] of Object.entries(accountEntries ?? {})) {
    const inheritedValue = merged[key];
    merged[key] =
      inheritedValue && value
        ? {
            ...inheritedValue,
            ...value,
          }
        : (value ?? inheritedValue);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
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
  if (resolveMatrixAccount({ cfg: params.cfg, accountId: DEFAULT_ACCOUNT_ID, env }).configured) {
    accountIds.add(DEFAULT_ACCOUNT_ID);
  }
  const ids = new Set<string>();

  for (const accountId of accountIds) {
    if (normalizeAccountId(accountId) === currentAccountId) {
      continue;
    }
    if (!resolveMatrixAccount({ cfg: params.cfg, accountId, env }).configured) {
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
  env?: NodeJS.ProcessEnv;
}): ResolvedMatrixAccount {
  const env = params.env ?? process.env;
  const accountId = normalizeAccountId(params.accountId);
  const matrixBase = resolveMatrixBaseConfig(params.cfg);
  const base = resolveMatrixAccountConfig({ cfg: params.cfg, accountId, env });
  const explicitAuthConfig =
    accountId === DEFAULT_ACCOUNT_ID
      ? base
      : (findMatrixAccountConfig(params.cfg, accountId) ?? {});
  const enabled = base.enabled !== false && matrixBase.enabled !== false;

  const resolved = resolveMatrixConfigForAccount(params.cfg, accountId, env);
  const hasHomeserver = Boolean(resolved.homeserver);
  const hasUserId = Boolean(resolved.userId);
  const hasAccessToken =
    Boolean(resolved.accessToken) || hasConfiguredSecretInput(explicitAuthConfig.accessToken);
  const hasPassword = Boolean(resolved.password);
  const hasPasswordAuth =
    hasUserId && (hasPassword || hasConfiguredSecretInput(explicitAuthConfig.password));
  const stored = loadMatrixCredentials(env, accountId);
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
  env?: NodeJS.ProcessEnv;
}): MatrixConfig {
  const env = params.env ?? process.env;
  const accountId = normalizeAccountId(params.accountId);
  const base = resolveMatrixBaseConfig(params.cfg);
  const merged = resolveMergedAccountConfig<MatrixConfig>({
    channelConfig: base,
    accounts: params.cfg.channels?.matrix?.accounts as
      | Record<string, Partial<MatrixConfig>>
      | undefined,
    accountId,
    normalizeAccountId,
    nestedObjectKeys: ["dm", "actions"],
  });
  const accountConfig = findMatrixAccountConfig(params.cfg, accountId);
  const groups = mergeMatrixRoomEntries(
    selectInheritedMatrixRoomEntries({
      entries: base.groups,
      accountId,
    }),
    accountConfig?.groups,
    Boolean(accountConfig && Object.hasOwn(accountConfig, "groups")),
  );
  const rooms = mergeMatrixRoomEntries(
    selectInheritedMatrixRoomEntries({
      entries: base.rooms,
      accountId,
    }),
    accountConfig?.rooms,
    Boolean(accountConfig && Object.hasOwn(accountConfig, "rooms")),
  );
  // Room maps need custom scoping, so keep the generic merge for all other fields.
  const { groups: _ignoredGroups, rooms: _ignoredRooms, ...rest } = merged;
  return {
    ...rest,
    ...(groups ? { groups } : {}),
    ...(rooms ? { rooms } : {}),
  };
}
