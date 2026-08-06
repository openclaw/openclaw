import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "facetime", "config", "audio"],
    message:
      'plugins.entries.facetime.config.audio belongs to the retired duplex BlackHole route. Run "openclaw doctor --fix" to use the paired OpenClaw-Mic/OpenClaw-Feed transport.',
    match: (value) => asRecord(value) !== undefined,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = asRecord(asRecord(asRecord(cfg.plugins)?.entries)?.facetime);
  const pluginConfig = asRecord(entry?.config);
  if (!pluginConfig || asRecord(pluginConfig.audio) === undefined) {
    return { config: cfg, changes: [] };
  }

  const config = structuredClone(cfg);
  const nextEntry = asRecord(asRecord(asRecord(config.plugins)?.entries)?.facetime);
  const nextPluginConfig = asRecord(nextEntry?.config);
  if (nextPluginConfig) {
    delete nextPluginConfig.audio;
  }
  return {
    config,
    changes: [
      "Removed the retired FaceTime duplex BlackHole audio configuration; the plugin now uses OpenClaw-Mic and OpenClaw-Feed.",
    ],
  };
}
