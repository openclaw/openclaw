import {
  type ChannelDoctorAdapter,
  type ChannelDoctorConfigMutation,
  type ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
  removePluginFromConfig,
} from "openclaw/plugin-sdk/runtime";
import {
  hasLegacyFlatAllowPrivateNetworkAlias,
  isPrivateNetworkOptInEnabled,
  migrateLegacyFlatAllowPrivateNetworkAlias,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  autoMigrateLegacyMatrixState,
  autoPrepareLegacyMatrixCrypto,
  detectLegacyMatrixCrypto,
  detectLegacyMatrixState,
  hasActionableMatrixMigration,
  hasPendingMatrixMigration,
  maybeCreateMatrixMigrationSnapshot,
} from "./matrix-migration.runtime.js";

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

function normalizeMatrixCompatibilityConfig(cfg: OpenClawConfig): ChannelDoctorConfigMutation {
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
        ...(cfg.channels ?? {}),
        matrix: updatedMatrix as NonNullable<OpenClawConfig["channels"]>["matrix"],
      },
    },
    changes,
  };
}

const MATRIX_LEGACY_CONFIG_RULES: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "matrix"],
    message:
      "channels.matrix.allowPrivateNetwork is legacy; use channels.matrix.network.dangerouslyAllowPrivateNetwork instead (auto-migrated on load).",
    match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(value) ? value : {}),
  },
  {
    path: ["channels", "matrix", "accounts"],
    message:
      "channels.matrix.accounts.<id>.allowPrivateNetwork is legacy; use channels.matrix.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead (auto-migrated on load).",
    match: hasLegacyMatrixAccountPrivateNetworkAliases,
  },
  {
    path: ["channels", "matrix", "groups"],
    message:
      "channels.matrix.groups.<room>.allow is legacy; use channels.matrix.groups.<room>.enabled instead (auto-migrated on load).",
    match: hasLegacyMatrixRoomMapAllowAliases,
  },
  {
    path: ["channels", "matrix", "rooms"],
    message:
      "channels.matrix.rooms.<room>.allow is legacy; use channels.matrix.rooms.<room>.enabled instead (auto-migrated on load).",
    match: hasLegacyMatrixRoomMapAllowAliases,
  },
  {
    path: ["channels", "matrix", "accounts"],
    message:
      "channels.matrix.accounts.<id>.{groups,rooms}.<room>.allow is legacy; use channels.matrix.accounts.<id>.{groups,rooms}.<room>.enabled instead (auto-migrated on load).",
    match: hasLegacyMatrixAccountRoomAllowAliases,
  },
];

function hasConfiguredMatrixChannel(cfg: OpenClawConfig): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return isRecord(channels?.matrix);
}

function hasConfiguredMatrixPluginSurface(cfg: OpenClawConfig): boolean {
  return Boolean(
    cfg.plugins?.installs?.matrix ||
    cfg.plugins?.entries?.matrix ||
    cfg.plugins?.allow?.includes("matrix") ||
    cfg.plugins?.deny?.includes("matrix"),
  );
}

function hasConfiguredMatrixEnv(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(
    ([key, value]) => key.startsWith("MATRIX_") && typeof value === "string" && value.trim(),
  );
}

function configMayNeedMatrixDoctorSequence(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  return (
    hasConfiguredMatrixChannel(cfg) ||
    hasConfiguredMatrixPluginSurface(cfg) ||
    hasConfiguredMatrixEnv(env)
  );
}

export function formatMatrixLegacyStatePreview(
  detection: Exclude<ReturnType<typeof detectLegacyMatrixState>, null | { warning: string }>,
): string {
  return [
    "- Matrix plugin upgraded in place.",
    `- Legacy sync store: ${detection.legacyStoragePath} -> ${detection.targetStoragePath}`,
    `- Legacy crypto store: ${detection.legacyCryptoPath} -> ${detection.targetCryptoPath}`,
    ...(detection.selectionNote ? [`- ${detection.selectionNote}`] : []),
    '- Run "openclaw doctor --fix" to migrate this Matrix state now.',
  ].join("\n");
}

export function formatMatrixLegacyCryptoPreview(
  detection: ReturnType<typeof detectLegacyMatrixCrypto>,
): string[] {
  const notes: string[] = [];
  for (const warning of detection.warnings) {
    notes.push(`- ${warning}`);
  }
  for (const plan of detection.plans) {
    notes.push(
      [
        `- Matrix encrypted-state migration is pending for account "${plan.accountId}".`,
        `- Legacy crypto store: ${plan.legacyCryptoPath}`,
        `- New recovery key file: ${plan.recoveryKeyPath}`,
        `- Migration state file: ${plan.statePath}`,
        '- Run "openclaw doctor --fix" to extract any saved backup key now. Backed-up room keys will restore automatically on next gateway start.',
      ].join("\n"),
    );
  }
  return notes;
}

export async function collectMatrixInstallPathWarnings(cfg: OpenClawConfig): Promise<string[]> {
  const issue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfg.plugins?.installs?.matrix,
  });
  if (!issue) {
    return [];
  }
  return formatPluginInstallPathIssue({
    issue,
    pluginLabel: "Matrix",
    defaultInstallCommand: "openclaw plugins install @openclaw/matrix",
  }).map((entry) => `- ${entry}`);
}

export async function cleanStaleMatrixPluginConfig(cfg: OpenClawConfig) {
  const issue = await detectPluginInstallPathIssue({
    pluginId: "matrix",
    install: cfg.plugins?.installs?.matrix,
  });
  if (!issue || issue.kind !== "missing-path") {
    return { config: cfg, changes: [] };
  }
  const { config, actions } = removePluginFromConfig(cfg, "matrix");
  const removed: string[] = [];
  if (actions.install) {
    removed.push("install record");
  }
  if (actions.loadPath) {
    removed.push("load path");
  }
  if (actions.entry) {
    removed.push("plugin entry");
  }
  if (actions.allowlist) {
    removed.push("allowlist entry");
  }
  if (removed.length === 0) {
    return { config: cfg, changes: [] };
  }
  return {
    config,
    changes: [
      `Removed stale Matrix plugin references (${removed.join(", ")}). The previous install path no longer exists: ${issue.path}`,
    ],
  };
}

export async function applyMatrixDoctorRepair(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const pendingMatrixMigration = hasPendingMatrixMigration({
    cfg: params.cfg,
    env: params.env,
  });
  const actionableMatrixMigration = hasActionableMatrixMigration({
    cfg: params.cfg,
    env: params.env,
  });

  let matrixSnapshotReady = true;
  if (actionableMatrixMigration) {
    try {
      const snapshot = await maybeCreateMatrixMigrationSnapshot({
        trigger: "doctor-fix",
        env: params.env,
      });
      changes.push(
        `Matrix migration snapshot ${snapshot.created ? "created" : "reused"} before applying Matrix upgrades.\n- ${snapshot.archivePath}`,
      );
    } catch (error) {
      matrixSnapshotReady = false;
      warnings.push(
        `- Failed creating a Matrix migration snapshot before repair: ${String(error)}`,
      );
      warnings.push(
        '- Skipping Matrix migration changes for now. Resolve the snapshot failure, then rerun "openclaw doctor --fix".',
      );
    }
  } else if (pendingMatrixMigration) {
    warnings.push(
      "- Matrix migration warnings are present, but no on-disk Matrix mutation is actionable yet. No pre-migration snapshot was needed.",
    );
  }

  if (!matrixSnapshotReady) {
    return { changes, warnings };
  }

  const matrixStateRepair = await autoMigrateLegacyMatrixState({
    cfg: params.cfg,
    env: params.env,
  });
  if (matrixStateRepair.changes.length > 0) {
    changes.push(
      [
        "Matrix plugin upgraded in place.",
        ...matrixStateRepair.changes.map((entry) => `- ${entry}`),
        "- No user action required.",
      ].join("\n"),
    );
  }
  if (matrixStateRepair.warnings.length > 0) {
    warnings.push(matrixStateRepair.warnings.map((entry) => `- ${entry}`).join("\n"));
  }

  const matrixCryptoRepair = await autoPrepareLegacyMatrixCrypto({
    cfg: params.cfg,
    env: params.env,
  });
  if (matrixCryptoRepair.changes.length > 0) {
    changes.push(
      [
        "Matrix encrypted-state migration prepared.",
        ...matrixCryptoRepair.changes.map((entry) => `- ${entry}`),
      ].join("\n"),
    );
  }
  if (matrixCryptoRepair.warnings.length > 0) {
    warnings.push(matrixCryptoRepair.warnings.map((entry) => `- ${entry}`).join("\n"));
  }

  return { changes, warnings };
}

export async function runMatrixDoctorSequence(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<{ changeNotes: string[]; warningNotes: string[] }> {
  const warningNotes: string[] = [];
  const changeNotes: string[] = [];
  const installWarnings = await collectMatrixInstallPathWarnings(params.cfg);
  if (installWarnings.length > 0) {
    warningNotes.push(installWarnings.join("\n"));
  }
  if (!configMayNeedMatrixDoctorSequence(params.cfg, params.env)) {
    return { changeNotes, warningNotes };
  }

  const legacyState = detectLegacyMatrixState({
    cfg: params.cfg,
    env: params.env,
  });
  const legacyCrypto = detectLegacyMatrixCrypto({
    cfg: params.cfg,
    env: params.env,
  });

  if (params.shouldRepair) {
    const repair = await applyMatrixDoctorRepair({
      cfg: params.cfg,
      env: params.env,
    });
    changeNotes.push(...repair.changes);
    warningNotes.push(...repair.warnings);
  } else if (legacyState) {
    if ("warning" in legacyState) {
      warningNotes.push(`- ${legacyState.warning}`);
    } else {
      warningNotes.push(formatMatrixLegacyStatePreview(legacyState));
    }
  }

  if (!params.shouldRepair && (legacyCrypto.warnings.length > 0 || legacyCrypto.plans.length > 0)) {
    warningNotes.push(...formatMatrixLegacyCryptoPreview(legacyCrypto));
  }

  return { changeNotes, warningNotes };
}

export const matrixDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "nestedOnly",
  groupModel: "sender",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: true,
  legacyConfigRules: MATRIX_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: ({ cfg }) => normalizeMatrixCompatibilityConfig(cfg),
  runConfigSequence: async ({ cfg, env, shouldRepair }) =>
    await runMatrixDoctorSequence({ cfg, env, shouldRepair }),
  cleanStaleConfig: async ({ cfg }) => await cleanStaleMatrixPluginConfig(cfg),
};
