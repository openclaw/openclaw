// FaceTime doctor contract repairs retired prototype config before strict validation.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { normalizeTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { faceTimeSenderId } from "./src/call-events.js";

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

/**
 * Moves or removes retired prototype keys so runtime sees only the canonical config shape, and
 * copies FaceTime callers into `commands.ownerAllowFrom` once, when they last meant "owner".
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
  const hasLegacyOwnerHandles = Object.hasOwn(pluginConfig, "whitelistHandles");
  const retiredKeys = RETIRED_CONFIG_KEYS.filter((key) => Object.hasOwn(pluginConfig, key));
  const realtime = asObjectRecord(pluginConfig.realtime);
  const hasRetiredBrain = Boolean(realtime && Object.hasOwn(realtime, "brain"));
  // One-shot by state: once any FaceTime owner is listed, the operator edits owners there.
  const ownerAllowFrom = cfg.commands?.ownerAllowFrom ?? [];
  const copiesOwners =
    !ownerAllowFrom.some((owner) => String(owner).trim().startsWith("facetime:")) &&
    normalizeTrimmedStringList(pluginConfig.ownerHandles ?? pluginConfig.whitelistHandles).length >
      0;
  if (!hasLegacyOwnerHandles && retiredKeys.length === 0 && !hasRetiredBrain && !copiesOwners) {
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
      const handles = Array.isArray(nextPluginConfig.whitelistHandles)
        ? normalizeTrimmedStringList(nextPluginConfig.whitelistHandles)
        : null;
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

  if (copiesOwners) {
    const added = normalizeTrimmedStringList(nextPluginConfig.ownerHandles)
      .map(faceTimeSenderId)
      .filter((owner, index, owners) => owner !== "facetime:" && owners.indexOf(owner) === index);
    nextConfig.commands = { ...nextConfig.commands, ownerAllowFrom: [...ownerAllowFrom, ...added] };
    changes.push(
      `Added FaceTime owner handles to commands.ownerAllowFrom (${added.join(", ")}). ${[...CONFIG_PATH, "ownerHandles"].join(".")} now only lists who may call; remove an entry from commands.ownerAllowFrom to take away owner tools.`,
    );
  }

  return { config: nextConfig, changes };
}
