import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { coerceSecretRef, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { findMatrixAccountConfig } from "./account-config.js";
import { shouldStoreMatrixAccountAtTopLevel } from "./config-paths.js";

export {
  resolveMatrixConfigFieldPath,
  resolveMatrixConfigPath,
  shouldStoreMatrixAccountAtTopLevel,
} from "./config-paths.js";

export type MatrixAccountPatch = {
  name?: string | null;
  enabled?: boolean;
  homeserver?: string | null;
  allowPrivateNetwork?: boolean | null;
  proxy?: string | null;
  userId?: string | null;
  accessToken?: MatrixConfig["accessToken"] | null;
  password?: MatrixConfig["password"] | null;
  deviceId?: string | null;
  deviceName?: string | null;
  avatarUrl?: string | null;
  encryption?: boolean | null;
  initialSyncLimit?: number | null;
  allowBots?: MatrixConfig["allowBots"] | null;
  autoJoin?: MatrixConfig["autoJoin"] | null;
  autoJoinAllowlist?: MatrixConfig["autoJoinAllowlist"] | null;
  dm?: MatrixConfig["dm"] | null;
  groupPolicy?: MatrixConfig["groupPolicy"] | null;
  groupAllowFrom?: MatrixConfig["groupAllowFrom"] | null;
  groups?: MatrixConfig["groups"] | null;
  rooms?: MatrixConfig["rooms"] | null;
};

function applyNullableField<T>(
  target: Record<string, unknown>,
  key: keyof MatrixAccountPatch,
  value: T | null | undefined,
  normalize: (value: T) => unknown = (entry) => entry,
): void {
  if (value === undefined) {
    return;
  }
  const normalized = value === null ? undefined : normalize(value);
  if (normalized === undefined) {
    delete target[key];
  } else {
    target[key] = normalized;
  }
}

function normalizeMatrixSecretInput(
  value: NonNullable<MatrixConfig["accessToken"]>,
  key: "accessToken" | "password",
  defaults?: NonNullable<CoreConfig["secrets"]>["defaults"],
) {
  if (typeof value === "string") {
    return normalizeSecretInputString(value) || undefined;
  }

  const ref = coerceSecretRef(value, defaults);
  if (!ref) {
    throw new Error(`Invalid Matrix ${key} SecretInput.`);
  }
  return ref;
}

function cloneMatrixDmConfig(dm: NonNullable<MatrixConfig["dm"]>): MatrixConfig["dm"] {
  return {
    ...dm,
    ...(dm.allowFrom ? { allowFrom: [...dm.allowFrom] } : {}),
  };
}

function cloneMatrixRoomMap(rooms: MatrixConfig["groups"]): MatrixConfig["groups"] {
  if (!rooms) {
    return rooms;
  }
  return Object.fromEntries(
    Object.entries(rooms).map(([roomId, roomCfg]) => [roomId, roomCfg ? { ...roomCfg } : roomCfg]),
  );
}

export function updateMatrixAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: MatrixAccountPatch,
): CoreConfig {
  const matrix = cfg.channels?.matrix ?? {};
  const normalizedAccountId = normalizeAccountId(accountId);
  const existingAccount = (findMatrixAccountConfig(cfg, normalizedAccountId) ??
    (normalizedAccountId === DEFAULT_ACCOUNT_ID ? matrix : {})) as MatrixConfig;
  const nextAccount: Record<string, unknown> = { ...existingAccount };

  const trimString = (value: string) => value.trim() || undefined;
  applyNullableField(nextAccount, "name", patch.name, trimString);
  if (typeof patch.enabled === "boolean") {
    nextAccount.enabled = patch.enabled;
  } else if (typeof nextAccount.enabled !== "boolean") {
    nextAccount.enabled = true;
  }

  applyNullableField(nextAccount, "homeserver", patch.homeserver, trimString);
  applyNullableField(nextAccount, "proxy", patch.proxy, trimString);
  applyNullableField(nextAccount, "userId", patch.userId, trimString);
  for (const key of ["accessToken", "password"] as const) {
    applyNullableField(nextAccount, key, patch[key], (value) =>
      normalizeMatrixSecretInput(value, key, cfg.secrets?.defaults),
    );
  }
  applyNullableField(nextAccount, "deviceId", patch.deviceId, trimString);
  applyNullableField(nextAccount, "deviceName", patch.deviceName, trimString);
  applyNullableField(nextAccount, "avatarUrl", patch.avatarUrl, trimString);
  if (patch.allowPrivateNetwork !== undefined) {
    const nextNetwork =
      nextAccount.network && typeof nextAccount.network === "object"
        ? { ...(nextAccount.network as Record<string, unknown>) }
        : {};
    if (patch.allowPrivateNetwork === null) {
      delete nextNetwork.dangerouslyAllowPrivateNetwork;
    } else {
      nextNetwork.dangerouslyAllowPrivateNetwork = patch.allowPrivateNetwork;
    }
    if (Object.keys(nextNetwork).length > 0) {
      nextAccount.network = nextNetwork;
    } else {
      delete nextAccount.network;
    }
  }

  applyNullableField(nextAccount, "initialSyncLimit", patch.initialSyncLimit, (value) =>
    resolveOptionalIntegerOption(value, { min: 0 }),
  );
  applyNullableField(nextAccount, "encryption", patch.encryption);
  applyNullableField(nextAccount, "allowBots", patch.allowBots);
  applyNullableField(nextAccount, "autoJoin", patch.autoJoin);
  applyNullableField(nextAccount, "autoJoinAllowlist", patch.autoJoinAllowlist, (value) => [
    ...value,
  ]);
  applyNullableField(nextAccount, "dm", patch.dm, (value) =>
    cloneMatrixDmConfig({ ...(nextAccount.dm as MatrixConfig["dm"] | undefined), ...value }),
  );
  applyNullableField(nextAccount, "groupPolicy", patch.groupPolicy);
  applyNullableField(nextAccount, "groupAllowFrom", patch.groupAllowFrom, (value) => [...value]);
  for (const key of ["groups", "rooms"] as const) {
    applyNullableField(nextAccount, key, patch[key], cloneMatrixRoomMap);
  }

  const nextAccounts = Object.fromEntries(
    Object.entries(matrix.accounts ?? {}).filter(
      ([rawAccountId]) =>
        rawAccountId === normalizedAccountId ||
        normalizeAccountId(rawAccountId) !== normalizedAccountId,
    ),
  );

  if (shouldStoreMatrixAccountAtTopLevel(cfg, normalizedAccountId)) {
    const { accounts: _ignoredAccounts, defaultAccount } = matrix;
    const {
      accounts: _ignoredNextAccounts,
      defaultAccount: _ignoredNextDefaultAccount,
      ...topLevelAccount
    } = nextAccount;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        matrix: {
          ...(defaultAccount ? { defaultAccount } : {}),
          enabled: true,
          ...topLevelAccount,
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...matrix,
        enabled: true,
        accounts: {
          ...nextAccounts,
          [normalizedAccountId]: nextAccount as MatrixConfig,
        },
      },
    },
  };
}
