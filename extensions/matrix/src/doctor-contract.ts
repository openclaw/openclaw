import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  hasLegacyFlatAllowPrivateNetworkAlias,
  migrateLegacyFlatAllowPrivateNetworkAlias,
} from "openclaw/plugin-sdk/ssrf-runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasLegacyMatrixRoomAllowAlias(value: unknown): boolean {
  const room = isRecord(value) ? value : null;
  return Boolean(room && typeof room.allow === "boolean");
}

function hasLegacyMatrixRoomMapAllowAliases(value: unknown): boolean {
  const rooms = isRecord(value) ? value : null;
  return Boolean(rooms && Object.values(rooms).some((room) => hasLegacyMatrixRoomAllowAlias(room)));
}

function hasLegacyMatrixAccountRoomAllowAliases(value: unknown): boolean {
  const accounts = isRecord(value) ? value : null;
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => {
    if (!isRecord(account)) {
      return false;
    }
    return (
      hasLegacyMatrixRoomMapAllowAliases(account.groups) ||
      hasLegacyMatrixRoomMapAllowAliases(account.rooms)
    );
  });
}

function hasLegacyMatrixAccountPrivateNetworkAliases(value: unknown): boolean {
  const accounts = isRecord(value) ? value : null;
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) =>
    hasLegacyFlatAllowPrivateNetworkAlias(isRecord(account) ? account : {}),
  );
}

function normalizeMatrixRoomAllowAliases(params: {
  rooms: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { rooms: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextRooms: Record<string, unknown> = { ...params.rooms };
  for (const [roomId, roomValue] of Object.entries(params.rooms)) {
    const room = isRecord(roomValue) ? roomValue : null;
    if (!room || typeof room.allow !== "boolean") {
      continue;
    }
    const nextRoom = { ...room };
    if (typeof nextRoom.enabled !== "boolean") {
      nextRoom.enabled = room.allow;
    }
    delete nextRoom.allow;
    nextRooms[roomId] = nextRoom;
    changed = true;
    params.changes.push(
      `Moved ${params.pathPrefix}.${roomId}.allow → ${params.pathPrefix}.${roomId}.enabled (${String(nextRoom.enabled)}).`,
    );
  }
  return { rooms: nextRooms, changed };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "matrix"],
    message:
      'channels.matrix.allowPrivateNetwork is legacy; use channels.matrix.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(value) ? value : {}),
  },
  {
    path: ["channels", "matrix", "accounts"],
    message:
      'channels.matrix.accounts.<id>.allowPrivateNetwork is legacy; use channels.matrix.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    match: hasLegacyMatrixAccountPrivateNetworkAliases,
  },
  {
    path: ["channels", "matrix", "groups"],
    message:
      'channels.matrix.groups.<room>.allow is legacy; use channels.matrix.groups.<room>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyMatrixRoomMapAllowAliases,
  },
  {
    path: ["channels", "matrix", "rooms"],
    message:
      'channels.matrix.rooms.<room>.allow is legacy; use channels.matrix.rooms.<room>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyMatrixRoomMapAllowAliases,
  },
  {
    path: ["channels", "matrix", "accounts"],
    message:
      'channels.matrix.accounts.<id>.{groups,rooms}.<room>.allow is legacy; use channels.matrix.accounts.<id>.{groups,rooms}.<room>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyMatrixAccountRoomAllowAliases,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  const matrix = isRecord(channels?.matrix) ? channels.matrix : null;
  if (!matrix) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updatedMatrix: Record<string, unknown> = matrix;
  let changed = false;

  const topLevelPrivateNetwork = migrateLegacyFlatAllowPrivateNetworkAlias({
    entry: updatedMatrix,
    pathPrefix: "channels.matrix",
    changes,
  });
  updatedMatrix = topLevelPrivateNetwork.entry;
  changed = changed || topLevelPrivateNetwork.changed;

  const normalizeTopLevelRoomScope = (key: "groups" | "rooms") => {
    const rooms = isRecord(updatedMatrix[key]) ? updatedMatrix[key] : null;
    if (!rooms) {
      return;
    }
    const normalized = normalizeMatrixRoomAllowAliases({
      rooms,
      pathPrefix: `channels.matrix.${key}`,
      changes,
    });
    if (normalized.changed) {
      updatedMatrix = { ...updatedMatrix, [key]: normalized.rooms };
      changed = true;
    }
  };

  normalizeTopLevelRoomScope("groups");
  normalizeTopLevelRoomScope("rooms");

  const accounts = isRecord(updatedMatrix.accounts) ? updatedMatrix.accounts : null;
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts: Record<string, unknown> = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = isRecord(accountValue) ? accountValue : null;
      if (!account) {
        continue;
      }
      let nextAccount: Record<string, unknown> = account;
      let accountChanged = false;

      const privateNetworkMigration = migrateLegacyFlatAllowPrivateNetworkAlias({
        entry: nextAccount,
        pathPrefix: `channels.matrix.accounts.${accountId}`,
        changes,
      });
      if (privateNetworkMigration.changed) {
        nextAccount = privateNetworkMigration.entry;
        accountChanged = true;
      }

      for (const key of ["groups", "rooms"] as const) {
        const rooms = isRecord(nextAccount[key]) ? nextAccount[key] : null;
        if (!rooms) {
          continue;
        }
        const normalized = normalizeMatrixRoomAllowAliases({
          rooms,
          pathPrefix: `channels.matrix.accounts.${accountId}.${key}`,
          changes,
        });
        if (normalized.changed) {
          nextAccount = { ...nextAccount, [key]: normalized.rooms };
          accountChanged = true;
        }
      }
      if (accountChanged) {
        nextAccounts[accountId] = nextAccount;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updatedMatrix = { ...updatedMatrix, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        matrix: updatedMatrix as NonNullable<OpenClawConfig["channels"]>["matrix"],
      },
    },
    changes,
  };
}
