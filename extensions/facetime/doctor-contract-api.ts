// FaceTime doctor contract repairs retired prototype config before strict validation.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { normalizeTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { faceTimeSenderId } from "./src/call-events.js";

const CONFIG_PATH = ["plugins", "entries", "facetime", "config"] as const;
const RETIRED_CONFIG_KEYS = ["helperHost", "helperPort"] as const;
const LEGACY_CALLER_KEYS = ["ownerHandles", "whitelistHandles"] as const;

type LegacyConfigRule = {
  path: string[];
  message: string;
};

export const legacyConfigRules: LegacyConfigRule[] = [
  ...LEGACY_CALLER_KEYS.map((key) => ({
    path: [...CONFIG_PATH, key],
    message: `${[...CONFIG_PATH, key].join(".")} is legacy; use allowedCallers. Run "openclaw doctor --fix".`,
  })),
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

/**
 * Moves or removes retired prototype keys so runtime sees only the canonical config shape. The
 * legacy caller keys made every caller the owner, so moving one also promotes its callers, once.
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = asObjectRecord(cfg.plugins?.entries?.facetime);
  const pluginConfig = asObjectRecord(entry?.config);
  if (!pluginConfig) {
    return { config: cfg, changes: [] };
  }
  const legacyCallerKeys = LEGACY_CALLER_KEYS.filter((key) => Object.hasOwn(pluginConfig, key));
  const retiredKeys = RETIRED_CONFIG_KEYS.filter((key) => Object.hasOwn(pluginConfig, key));
  const realtime = asObjectRecord(pluginConfig.realtime);
  const hasRetiredBrain = Boolean(realtime && Object.hasOwn(realtime, "brain"));
  if (legacyCallerKeys.length === 0 && retiredKeys.length === 0 && !hasRetiredBrain) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextEntry = asObjectRecord(nextConfig.plugins?.entries?.facetime);
  const nextPluginConfig = asObjectRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }
  const changes: string[] = [];

  const targetPath = [...CONFIG_PATH, "allowedCallers"].join(".");
  const moved = Object.hasOwn(nextPluginConfig, "allowedCallers") ? undefined : legacyCallerKeys[0];
  for (const key of legacyCallerKeys) {
    const sourcePath = [...CONFIG_PATH, key].join(".");
    const value = nextPluginConfig[key];
    delete nextPluginConfig[key];
    if (key !== moved) {
      changes.push(`Removed ${sourcePath}; ${targetPath} is authoritative.`);
      continue;
    }
    if (!Array.isArray(value)) {
      changes.push(`Removed invalid ${sourcePath}; configure ${targetPath}.`);
      continue;
    }
    const handles = normalizeTrimmedStringList(value);
    nextPluginConfig.allowedCallers = handles;
    changes.push(`Moved ${sourcePath} to ${targetPath}.`);
    const current = nextConfig.commands?.ownerAllowFrom ?? [];
    const owners = new Set(current.map((owner) => String(owner).trim()));
    const added = handles
      .map(faceTimeSenderId)
      .filter((owner) => owner !== "facetime:" && !owners.has(owner) && owners.add(owner));
    if (added.length > 0) {
      nextConfig.commands = { ...nextConfig.commands, ownerAllowFrom: [...current, ...added] };
      changes.push(
        `Added FaceTime callers to commands.ownerAllowFrom (${added.join(", ")}), because ${sourcePath} gave every caller owner tools. ${targetPath} only lists who may call; remove an entry from commands.ownerAllowFrom to take away owner tools.`,
      );
    }
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
