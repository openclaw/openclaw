import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";

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
