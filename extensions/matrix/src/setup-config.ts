import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeSecretInputString,
  type ChannelSetupInput,
} from "openclaw/plugin-sdk/setup";
import { resolveMatrixEnvAuthReadiness } from "./matrix/client/env-auth.js";
import { updateMatrixAccountConfig } from "./matrix/config-update.js";
import type { CoreConfig } from "./types.js";

const channel = "matrix" as const;
const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
  "name",
  "enabled",
  "httpPort",
  "webhookPath",
  "webhookUrl",
  "webhookSecret",
  "service",
  "region",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceName",
  "url",
  "code",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
]);
const MATRIX_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
  "deviceId",
  "avatarUrl",
  "initialSyncLimit",
  "encryption",
  "allowlistOnly",
  "allowBots",
  "blockStreaming",
  "replyToMode",
  "threadReplies",
  "textChunkLimit",
  "chunkMode",
  "responsePrefix",
  "ackReaction",
  "ackReactionScope",
  "reactionNotifications",
  "threadBindings",
  "startupVerification",
  "startupVerificationCooldownHours",
  "mediaMaxMb",
  "autoJoin",
  "autoJoinAllowlist",
  "dm",
  "groups",
  "rooms",
  "actions",
]);
const MATRIX_NAMED_ACCOUNT_PROMOTION_KEYS = new Set([
  // When named accounts already exist, only move auth/bootstrap fields into the
  // promoted account. Delivery-policy fields stay at the top level so they
  // remain shared inherited defaults for every account.
  "name",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceId",
  "deviceName",
  "avatarUrl",
  "initialSyncLimit",
  "encryption",
]);

function cloneIfObject<T>(value: T): T {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

function moveSingleMatrixAccountConfigToNamedAccount(cfg: CoreConfig): CoreConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[channel];
  const base =
    typeof baseConfig === "object" && baseConfig
      ? (baseConfig as Record<string, unknown>)
      : undefined;
  if (!base) {
    return cfg;
  }

  const accounts =
    typeof base.accounts === "object" && base.accounts
      ? (base.accounts as Record<string, Record<string, unknown>>)
      : {};
  const hasNamedAccounts = Object.keys(accounts).filter(Boolean).length > 0;
  const keysToMove = Object.entries(base)
    .filter(([key, value]) => {
      if (key === "accounts" || key === "enabled" || value === undefined) {
        return false;
      }
      if (
        !COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key) &&
        !MATRIX_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(key)
      ) {
        return false;
      }
      if (hasNamedAccounts && !MATRIX_NAMED_ACCOUNT_PROMOTION_KEYS.has(key)) {
        return false;
      }
      return true;
    })
    .map(([key]) => key);
  if (keysToMove.length === 0) {
    return cfg;
  }

  const defaultAccount =
    typeof base.defaultAccount === "string" && base.defaultAccount.trim()
      ? normalizeAccountId(base.defaultAccount)
      : undefined;
  const targetAccountId =
    defaultAccount && defaultAccount !== DEFAULT_ACCOUNT_ID
      ? (Object.entries(accounts).find(
          ([accountId, value]) =>
            accountId &&
            value &&
            typeof value === "object" &&
            normalizeAccountId(accountId) === defaultAccount,
        )?.[0] ?? DEFAULT_ACCOUNT_ID)
      : (defaultAccount ??
        (Object.keys(accounts).filter(Boolean).length === 1
          ? Object.keys(accounts).filter(Boolean)[0]
          : DEFAULT_ACCOUNT_ID));

  const nextAccount: Record<string, unknown> = { ...(accounts[targetAccountId] ?? {}) };
  for (const key of keysToMove) {
    nextAccount[key] = cloneIfObject(base[key]);
  }
  const nextChannel = { ...base };
  for (const key of keysToMove) {
    delete nextChannel[key];
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: {
        ...nextChannel,
        accounts: {
          ...accounts,
          [targetAccountId]: nextAccount,
        },
      },
    },
  };
}

export function validateMatrixSetupInput(params: {
  accountId: string;
  input: ChannelSetupInput;
}): string | null {
  if (params.input.useEnv) {
    const envReadiness = resolveMatrixEnvAuthReadiness(params.accountId, process.env);
    return envReadiness.ready ? null : envReadiness.missingMessage;
  }
  if (!params.input.homeserver?.trim()) {
    return "Matrix requires --homeserver";
  }
  const accessToken = params.input.accessToken?.trim();
  const password = normalizeSecretInputString(params.input.password);
  const userId = params.input.userId?.trim();
  if (!accessToken && !password) {
    return "Matrix requires --access-token or --password";
  }
  if (!accessToken) {
    if (!userId) {
      return "Matrix requires --user-id when using --password";
    }
    if (!password) {
      return "Matrix requires --password when using --user-id";
    }
  }
  return null;
}

export function applyMatrixSetupAccountConfig(params: {
  cfg: CoreConfig;
  accountId: string;
  input: ChannelSetupInput;
  avatarUrl?: string;
}): CoreConfig {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const migratedCfg =
    normalizedAccountId !== DEFAULT_ACCOUNT_ID
      ? moveSingleMatrixAccountConfigToNamedAccount(params.cfg)
      : params.cfg;
  const next = applyAccountNameToChannelSection({
    cfg: migratedCfg,
    channelKey: channel,
    accountId: normalizedAccountId,
    name: params.input.name,
  }) as CoreConfig;

  if (params.input.useEnv) {
    return updateMatrixAccountConfig(next, normalizedAccountId, {
      enabled: true,
      homeserver: null,
      allowPrivateNetwork: null,
      proxy: null,
      userId: null,
      accessToken: null,
      password: null,
      deviceId: null,
      deviceName: null,
    });
  }

  const accessToken = params.input.accessToken?.trim();
  const password = normalizeSecretInputString(params.input.password);
  const userId = params.input.userId?.trim();
  return updateMatrixAccountConfig(next, normalizedAccountId, {
    enabled: true,
    homeserver: params.input.homeserver?.trim(),
    allowPrivateNetwork:
      typeof params.input.allowPrivateNetwork === "boolean"
        ? params.input.allowPrivateNetwork
        : undefined,
    proxy: params.input.proxy?.trim() || undefined,
    userId: password && !userId ? null : userId,
    accessToken: accessToken || (password ? null : undefined),
    password: password || (accessToken ? null : undefined),
    deviceName: params.input.deviceName?.trim(),
    avatarUrl: params.avatarUrl,
    initialSyncLimit: params.input.initialSyncLimit,
  });
}
