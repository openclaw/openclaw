import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { defineStrayPluginEntryConfigMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ReefChannelConfigSchema } from "./src/config-schema.js";

function hasRetiredReefPolicyConfig(value: unknown): boolean {
  return isRecord(value) && ["dmPolicy", "allowFrom"].some((key) => Object.hasOwn(value, key));
}

// Reef reads channels.reef only. Older manifests advertised the full channel
// schema as plugin-entry config, so a Control UI plugin form could park values
// under plugins.entries.reef.config where the runtime never saw them.
const reefStrayEntryConfigMigration = defineStrayPluginEntryConfigMigration({
  pluginId: "reef",
  channelId: "reef",
  validateMergedChannelConfig: (merged) => ReefChannelConfigSchema.safeParse(merged).success,
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "reef"],
    message:
      'channels.reef dmPolicy/allowFrom are legacy; run "openclaw doctor --fix" to remove them. Peer trust is SQLite-backed.',
    match: hasRetiredReefPolicyConfig,
  },
  reefStrayEntryConfigMigration.legacyConfigRule,
];

export function normalizeCompatibilityConfig({
  cfg,
  authProfileIdMap,
}: {
  cfg: OpenClawConfig;
  authProfileIdMap?: ReadonlyMap<string, string>;
}): {
  config: OpenClawConfig;
  changes: string[];
} {
  const reef = cfg.channels?.reef;
  let config = cfg;
  const changes: string[] = [];
  if (isRecord(reef) && hasRetiredReefPolicyConfig(reef)) {
    const next = structuredClone(cfg);
    const nextReef = next.channels?.reef;
    if (isRecord(nextReef)) {
      for (const key of ["dmPolicy", "allowFrom"] as const) {
        if (Object.hasOwn(nextReef, key)) {
          delete nextReef[key];
          changes.push(`Removed retired Reef ${key} field.`);
        }
      }
      config = next;
    }
  }
  const stray = reefStrayEntryConfigMigration.normalizeConfig({ cfg: config });
  config = stray.config;
  changes.push(...stray.changes);
  const guard = isRecord(config.channels?.reef) ? config.channels.reef.guard : undefined;
  const renamed =
    isRecord(guard) && typeof guard.authProfileId === "string"
      ? authProfileIdMap?.get(guard.authProfileId)
      : undefined;
  if (renamed && isRecord(guard) && renamed !== guard.authProfileId) {
    config = structuredClone(config);
    const nextReef = config.channels?.reef;
    if (isRecord(nextReef) && isRecord(nextReef.guard)) {
      nextReef.guard.authProfileId = renamed;
      changes.push("Updated Reef guard to the renamed auth profile.");
    }
  }
  return { config, changes };
}
