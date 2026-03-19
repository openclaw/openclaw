import { resolveMatrixEnvAuthReadiness } from "./matrix/client.js";
import { updateMatrixAccountConfig } from "./matrix/config-update.js";
import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  moveSingleAccountChannelSectionToDefaultAccount,
  normalizeAccountId,
  normalizeSecretInputString,
  type ChannelSetupInput,
} from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

const channel = "matrix" as const;

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
      ? (moveSingleAccountChannelSectionToDefaultAccount({
          cfg: params.cfg,
          channelKey: channel,
        }) as CoreConfig)
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
    userId: password && !userId ? null : userId,
    accessToken: accessToken || (password ? null : undefined),
    password: password || (accessToken ? null : undefined),
    deviceName: params.input.deviceName?.trim(),
    avatarUrl: params.avatarUrl,
    initialSyncLimit: params.input.initialSyncLimit,
  });
}
