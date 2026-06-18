// XMemo memory plugin doctor contract.
//
// Exposes config compatibility fixes for OpenClaw `openclaw doctor --fix`.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type LegacyConfigRule = {
  path: string[];
  message: string;
};

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "config", "xmemo-memory"],
    message:
      "XMemo memory config moved from plugins.config to plugins.entries['xmemo-memory'].config. Run `openclaw doctor --fix` to migrate.",
  },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const plugins = asRecord(cfg.plugins);
  const legacyConfig = asRecord(plugins?.config)?.["xmemo-memory"];
  const entries = asRecord(plugins?.entries);
  const existingEntry = asRecord(entries?.["xmemo-memory"]);

  if (!legacyConfig || typeof legacyConfig !== "object" || Array.isArray(legacyConfig)) {
    return { config: cfg, changes: [] };
  }

  const legacy = legacyConfig as Record<string, unknown>;
  const currentConfig = asRecord(existingEntry?.config) ?? {};

  const migrated: Record<string, unknown> = { ...currentConfig };
  for (const [key, value] of Object.entries(legacy)) {
    if (migrated[key] === undefined) {
      migrated[key] = value;
    }
  }

  // Rename deprecated token to apiKey if apiKey is not already set.
  if (migrated.token !== undefined && migrated.apiKey === undefined) {
    migrated.apiKey = migrated.token;
    delete migrated.token;
  }

  const nextEntries: Record<string, unknown> = { ...entries };
  nextEntries["xmemo-memory"] = {
    ...existingEntry,
    enabled: (existingEntry?.enabled as boolean | undefined) ?? true,
    config: migrated,
  };

  const nextPlugins: Record<string, unknown> = { ...plugins };
  const nextLegacyConfig: Record<string, unknown> = { ...asRecord(nextPlugins.config) };
  delete nextLegacyConfig["xmemo-memory"];
  if (Object.keys(nextLegacyConfig).length === 0) {
    delete nextPlugins.config;
  } else {
    nextPlugins.config = nextLegacyConfig;
  }
  nextPlugins.entries = nextEntries;

  return {
    config: { ...cfg, plugins: nextPlugins } as OpenClawConfig,
    changes: [
      "Moved xmemo-memory config from plugins.config to plugins.entries['xmemo-memory'].config.",
      ...(legacy.token !== undefined ? ["Renamed deprecated token to apiKey."] : []),
    ],
  };
}
