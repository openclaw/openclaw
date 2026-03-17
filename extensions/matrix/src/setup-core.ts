import {
  normalizeAccountId,
  normalizeSecretInputString,
  prepareScopedSetupConfig,
  type ChannelSetupAdapter,
} from "openclaw/plugin-sdk/setup";
import type { CoreConfig } from "./types.js";

const channel = "matrix" as const;

export function buildMatrixConfigUpdate(
  cfg: CoreConfig,
  input: {
    homeserver?: string;
    userId?: string;
    accessToken?: string;
    password?: string;
    deviceName?: string;
    initialSyncLimit?: number;
  },
): CoreConfig {
  const existing = cfg.channels?.matrix ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...existing,
        enabled: true,
        ...(input.homeserver ? { homeserver: input.homeserver } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
        ...(input.password ? { password: input.password } : {}),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
        ...(typeof input.initialSyncLimit === "number"
          ? { initialSyncLimit: input.initialSyncLimit }
          : {}),
      },
    },
  };
}

export const matrixSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    prepareScopedSetupConfig({
      cfg: cfg as CoreConfig,
      channelKey: channel,
      accountId,
      name,
    }) as CoreConfig,
  validateInput: ({ input }) => {
    if (input.useEnv) {
      return null;
    }
    if (!input.homeserver?.trim()) {
      return "Matrix requires --homeserver";
    }
    const accessToken = input.accessToken?.trim();
    const password = normalizeSecretInputString(input.password);
    const userId = input.userId?.trim();
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
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const next = prepareScopedSetupConfig({
      cfg: cfg as CoreConfig,
      channelKey: channel,
      accountId,
      name: input.name,
      migrateBaseName: true,
    }) as CoreConfig;
    if (input.useEnv) {
      return {
        ...next,
        channels: {
          ...next.channels,
          matrix: {
            ...next.channels?.matrix,
            enabled: true,
          },
        },
      } as CoreConfig;
    }
    return buildMatrixConfigUpdate(next as CoreConfig, {
      homeserver: input.homeserver?.trim(),
      userId: input.userId?.trim(),
      accessToken: input.accessToken?.trim(),
      password: normalizeSecretInputString(input.password),
      deviceName: input.deviceName?.trim(),
      initialSyncLimit: input.initialSyncLimit,
    });
  },
};
