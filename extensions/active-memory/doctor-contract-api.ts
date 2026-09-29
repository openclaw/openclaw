import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  asObjectRecord,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

const RETIRED_QMD_CONFIG_PATH = ["plugins", "entries", "active-memory", "config", "qmd"];

/** Retired Active Memory QMD override detected before strict manifest validation. */
export const legacyConfigRules = [
  {
    path: RETIRED_QMD_CONFIG_PATH,
    message:
      'plugins.entries.active-memory.config.qmd is retired because the QMD memory backend was removed. Run "openclaw doctor --fix".',
  },
];

/** Removes the retired plugin-owned QMD override. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = asObjectRecord(cfg.plugins?.entries?.["active-memory"]);
  const pluginConfig = asObjectRecord(entry?.config);
  if (!pluginConfig || !Object.hasOwn(pluginConfig, "qmd")) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextEntry = asObjectRecord(nextConfig.plugins?.entries?.["active-memory"]);
  const nextPluginConfig = asObjectRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }
  delete nextPluginConfig.qmd;
  return {
    config: nextConfig,
    changes: ["Removed retired Active Memory QMD search-mode configuration."],
  };
}

async function collectRetiredToggleWarnings(stateDir: string): Promise<string[]> {
  const source = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
  try {
    await fs.lstat(source);
  } catch (error) {
    if (extractErrorCode(error) !== "ENOENT") {
      throw error;
    }
    return [];
  }
  return [
    `Preserved retired Active Memory JSON state at ${source}. Run openclaw doctor --fix on 2026.9.5 before upgrading to latest: https://docs.openclaw.ai/install/updating#upgrading-very-old-versions`,
  ];
}

// Retain the action identity until pending imports have no remaining legacy source.
export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "active-memory-session-toggles-json-to-plugin-state",
    label: "Retired Active Memory session toggles",
    async detectLegacyState({ stateDir }) {
      const preview = await collectRetiredToggleWarnings(stateDir);
      return preview.length > 0 ? { preview } : null;
    },
    async migrateLegacyState({ stateDir }) {
      return { changes: [], warnings: await collectRetiredToggleWarnings(stateDir) };
    },
  },
];
