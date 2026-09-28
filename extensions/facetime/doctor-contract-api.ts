// FaceTime doctor contract repairs retired prototype config before strict validation.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const CONFIG_PATH = ["plugins", "entries", "facetime", "config"] as const;
const RETIRED_CONFIG_KEYS = ["helperHost", "helperPort"] as const;

type LegacyConfigRule = {
  path: string[];
  message: string;
};

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: [...CONFIG_PATH, "whitelistHandles"],
    message:
      'plugins.entries.facetime.config.whitelistHandles is legacy; use ownerHandles. Run "openclaw doctor --fix".',
  },
  ...RETIRED_CONFIG_KEYS.map((key) => ({
    path: [...CONFIG_PATH, key],
    message: `${[...CONFIG_PATH, key].join(".")} is retired; FaceTime now uses its local authenticated helper endpoint. Run "openclaw doctor --fix".`,
  })),
  {
    path: [...CONFIG_PATH, "realtime", "brain"],
    message:
      'plugins.entries.facetime.config.realtime.brain is retired; FaceTime always consults the configured agent. Run "openclaw doctor --fix".',
  },
];

function normalizeLegacyOwnerHandles(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** Moves or removes retired prototype keys so runtime sees only the canonical config shape. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = asObjectRecord(cfg.plugins?.entries?.facetime);
  const pluginConfig = asObjectRecord(entry?.config);
  if (!pluginConfig) {
    return { config: cfg, changes: [] };
  }
  const hasLegacyOwnerHandles = Object.hasOwn(pluginConfig, "whitelistHandles");
  const retiredKeys = RETIRED_CONFIG_KEYS.filter((key) => Object.hasOwn(pluginConfig, key));
  const realtime = asObjectRecord(pluginConfig.realtime);
  const hasRetiredBrain = Boolean(realtime && Object.hasOwn(realtime, "brain"));
  if (!hasLegacyOwnerHandles && retiredKeys.length === 0 && !hasRetiredBrain) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextEntry = asObjectRecord(nextConfig.plugins?.entries?.facetime);
  const nextPluginConfig = asObjectRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }
  const changes: string[] = [];

  if (hasLegacyOwnerHandles) {
    const sourcePath = [...CONFIG_PATH, "whitelistHandles"].join(".");
    const targetPath = [...CONFIG_PATH, "ownerHandles"].join(".");
    if (Object.hasOwn(nextPluginConfig, "ownerHandles")) {
      changes.push(`Removed ${sourcePath}; ${targetPath} is authoritative.`);
    } else {
      const handles = normalizeLegacyOwnerHandles(nextPluginConfig.whitelistHandles);
      if (handles) {
        nextPluginConfig.ownerHandles = handles;
        changes.push(`Moved ${sourcePath} to ${targetPath}.`);
      } else {
        changes.push(`Removed invalid ${sourcePath}; configure ${targetPath}.`);
      }
    }
    delete nextPluginConfig.whitelistHandles;
  }

  for (const key of retiredKeys) {
    delete nextPluginConfig[key];
    changes.push(`Removed retired ${[...CONFIG_PATH, key].join(".")}.`);
  }

  const nextRealtime = asObjectRecord(nextPluginConfig.realtime);
  if (hasRetiredBrain && nextRealtime) {
    delete nextRealtime.brain;
    changes.push(`Removed retired ${[...CONFIG_PATH, "realtime", "brain"].join(".")}.`);
  }

  return { config: nextConfig, changes };
}
