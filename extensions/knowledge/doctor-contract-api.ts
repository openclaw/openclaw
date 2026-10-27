import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";

const REVIEW_JOB_PATH = "plugins.entries.knowledge.config.maintenance.reviewJobId";

/** Retired Knowledge config Doctor reports. */
export const legacyConfigRules = [
  {
    path: ["plugins", "entries", "knowledge", "config", "maintenance"],
    message: `${REVIEW_JOB_PATH} is retired: maintenance no longer queues the review, which runs on its own schedule. Run "openclaw doctor --fix" to remove it.`,
    match: (value: unknown) => asObjectRecord(value)?.reviewJobId !== undefined,
  },
];

/**
 * Remove the retired `maintenance.reviewJobId` so the Knowledge config validates
 * again. The review scribe's own automation keeps its schedule; nothing else changes.
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = cfg.plugins?.entries?.knowledge;
  const pluginConfig = asObjectRecord(entry?.config);
  const maintenance = asObjectRecord(pluginConfig?.maintenance);
  if (!entry || !pluginConfig || maintenance?.reviewJobId === undefined) {
    return { config: cfg, changes: [] };
  }
  const kept = { ...maintenance };
  delete kept.reviewJobId;
  return {
    config: {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        entries: {
          ...cfg.plugins?.entries,
          knowledge: { ...entry, config: { ...pluginConfig, maintenance: kept } },
        },
      },
    },
    changes: [`Removed ${REVIEW_JOB_PATH}; the review scribe runs on its own schedule.`],
  };
}
