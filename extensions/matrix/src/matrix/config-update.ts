import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { coerceSecretRef } from "openclaw/plugin-sdk/config-runtime";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/setup";
import type { CoreConfig, MatrixConfig } from "../types.js";
import { findMatrixAccountConfig } from "./account-config.js";
import {
  resolveMatrixConfigFieldPath,
  resolveMatrixConfigPath,
  shouldStoreMatrixAccountAtTopLevel,
} from "./config-paths.js";

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
  dm?: MatrixConfig["dm"] | null;
  groupPolicy?: MatrixConfig["groupPolicy"] | null;
  groupAllowFrom?: MatrixConfig["groupAllowFrom"] | null;
  groups?: MatrixConfig["groups"] | null;
  rooms?: MatrixConfig["rooms"] | null;
};

function applyNullableStringField(
  target: Record<string, unknown>,
  key: keyof MatrixAccountPatch,
  value: string | null | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    delete target[key];
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    delete target[key];
    return;
  }
  target[key] = trimmed;
}

function applyNullableSecretInputField(
  target: Record<string, unknown>,
  key: "accessToken" | "password",
  value: MatrixConfig["accessToken"] | MatrixConfig["password"] | null | undefined,
  defaults?: NonNullable<CoreConfig["secrets"]>["defaults"],
): void {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    delete target[key];
    return;
  }
  if (typeof value === "string") {
    const normalized = normalizeSecretInputString(value);
    if (normalized) {
      target[key] = normalized;
    } else {
      delete target[key];
    }
    return;
  }

  const ref = coerceSecretRef(value, defaults);
  if (!ref) {
    throw new Error(`Invalid Matrix ${key} SecretInput.`);
  }
  target[key] = ref;
}

function cloneMatrixDmConfig(dm: MatrixConfig["dm"]): MatrixConfig["dm"] {
  if (!dm) {
    return dm;
  }
  return {
    ...dm,
    ...(dm.allowFrom ? { allowFrom: [...dm.allowFrom] } : {}),
  };
}

function cloneMatrixRoomMap(
  rooms: MatrixConfig["groups"] | MatrixConfig["rooms"],
): MatrixConfig["groups"] | MatrixConfig["rooms"] {
  if (!rooms) {
    return rooms;
  }
  return Object.fromEntries(
    Object.entries(rooms).map(([roomId, roomCfg]) => [roomId, roomCfg ? { ...roomCfg } : roomCfg]),
  );
}

function applyNullableArrayField(
  target: Record<string, unknown>,
  key: keyof MatrixAccountPatch,
  value: Array<string | number> | null | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = [...value];
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

  if (patch.name !== undefined) {
    if (patch.name === null) {
      delete nextAccount.name;
    } else {
      const trimmed = patch.name.trim();
      if (trimmed) {
        nextAccount.name = trimmed;
      } else {
        delete nextAccount.name;
      }
    }
  }
  if (typeof patch.enabled === "boolean") {
    nextAccount.enabled = patch.enabled;
  } else if (typeof nextAccount.enabled !== "boolean") {
    nextAccount.enabled = true;
  }

  applyNullableStringField(nextAccount, "homeserver", patch.homeserver);
  applyNullableStringField(nextAccount, "proxy", patch.proxy);
  applyNullableStringField(nextAccount, "userId", patch.userId);
  applyNullableSecretInputField(
    nextAccount,
    "accessToken",
    patch.accessToken,
    cfg.secrets?.defaults,
  );
  applyNullableSecretInputField(nextAccount, "password", patch.password, cfg.secrets?.defaults);
  applyNullableStringField(nextAccount, "deviceId", patch.deviceId);
  applyNullableStringField(nextAccount, "deviceName", patch.deviceName);
  applyNullableStringField(nextAccount, "avatarUrl", patch.avatarUrl);

  if (patch.allowPrivateNetwork !== undefined) {
    if (patch.allowPrivateNetwork === null) {
      delete nextAccount.allowPrivateNetwork;
    } else {
      nextAccount.allowPrivateNetwork = patch.allowPrivateNetwork;
    }
  }

  if (patch.initialSyncLimit !== undefined) {
    if (patch.initialSyncLimit === null) {
      delete nextAccount.initialSyncLimit;
    } else {
      nextAccount.initialSyncLimit = Math.max(0, Math.floor(patch.initialSyncLimit));
    }
  }

  if (patch.encryption !== undefined) {
    if (patch.encryption === null) {
      delete nextAccount.encryption;
    } else {
      nextAccount.encryption = patch.encryption;
    }
  }
  if (patch.allowBots !== undefined) {
    if (patch.allowBots === null) {
      delete nextAccount.allowBots;
    } else {
      nextAccount.allowBots = patch.allowBots;
    }
  }
  if (patch.dm !== undefined) {
    if (patch.dm === null) {
      delete nextAccount.dm;
    } else {
      nextAccount.dm = cloneMatrixDmConfig({
        ...((nextAccount.dm as MatrixConfig["dm"] | undefined) ?? {}),
        ...patch.dm,
      });
    }
  }
  if (patch.groupPolicy !== undefined) {
    if (patch.groupPolicy === null) {
      delete nextAccount.groupPolicy;
    } else {
      nextAccount.groupPolicy = patch.groupPolicy;
    }
  }
  applyNullableArrayField(nextAccount, "groupAllowFrom", patch.groupAllowFrom);
  if (patch.groups !== undefined) {
    if (patch.groups === null) {
      delete nextAccount.groups;
    } else {
      nextAccount.groups = cloneMatrixRoomMap(patch.groups);
    }
  }
  if (patch.rooms !== undefined) {
    if (patch.rooms === null) {
      delete nextAccount.rooms;
    } else {
      nextAccount.rooms = cloneMatrixRoomMap(patch.rooms);
    }
  }

  const nextAccounts = Object.fromEntries(
    Object.entries(matrix.accounts ?? {}).filter(
      ([rawAccountId]) =>
        rawAccountId === normalizedAccountId ||
        normalizeAccountId(rawAccountId) !== normalizedAccountId,
    ),
  );

  if (shouldStoreMatrixAccountAtTopLevel(cfg, normalizedAccountId)) {
    const { accounts: _ignoredAccounts, defaultAccount, ...baseMatrix } = matrix;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        matrix: {
          ...baseMatrix,
          ...(defaultAccount ? { defaultAccount } : {}),
          enabled: true,
          ...nextAccount,
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
