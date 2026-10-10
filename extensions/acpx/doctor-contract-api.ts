// ACPX doctor contract repairs shipped config and migrates plugin-owned runtime state.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

const ACPX_CONFIG_PATH = ["plugins", "entries", "acpx", "config"] as const;
const RETIRED_ACPX_CONFIG_KEYS = ["strictWindowsCmdWrapper", "queueOwnerTtlSeconds"] as const;

/** Retired ACPX config that `openclaw doctor --fix` removes before strict validation. */
export const legacyConfigRules = RETIRED_ACPX_CONFIG_KEYS.map((key) => ({
  path: [...ACPX_CONFIG_PATH, key],
  message: `${[...ACPX_CONFIG_PATH, key].join(".")} is retired and ignored by the embedded ACPX runtime. Run "openclaw doctor --fix".`,
}));

/** Removes retired plugin-owned config without keeping runtime compatibility keys. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = asObjectRecord(cfg.plugins?.entries?.acpx);
  const pluginConfig = asObjectRecord(entry?.config);
  const retiredKeys = RETIRED_ACPX_CONFIG_KEYS.filter((key) =>
    Object.hasOwn(pluginConfig ?? {}, key),
  );
  if (!pluginConfig || retiredKeys.length === 0) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextEntry = asObjectRecord(nextConfig.plugins?.entries?.acpx);
  const nextPluginConfig = asObjectRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }
  for (const key of retiredKeys) {
    delete nextPluginConfig[key];
  }

  return {
    config: nextConfig,
    changes: [
      `Removed retired ACPX plugin config: ${retiredKeys.map((key) => [...ACPX_CONFIG_PATH, key].join(".")).join(", ")}.`,
    ],
  };
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "acpx-session-owner-resources",
    label: "ACP session owners",
    doctorOnly: true,
    phase: "after-session-repair",
    async collectBackupResources(input) {
      return (await import("./src/session-owner-migration.js")).acpxSessionOwnerMigration
        .collectBackupResources!(input);
    },
    async detectLegacyState(input) {
      return (
        await import("./src/session-owner-migration.js")
      ).acpxSessionOwnerMigration.detectLegacyState(input);
    },
    async migrateLegacyState(input) {
      return (
        await import("./src/session-owner-migration.js")
      ).acpxSessionOwnerMigration.migrateLegacyState(input);
    },
  },
];
