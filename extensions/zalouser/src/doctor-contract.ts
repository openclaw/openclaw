import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  defineKeyMoveMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

const groupAllowMigration = defineKeyMoveMigration({
  scope: ["groups", "*"],
  from: ["allow"],
  to: ["enabled"],
  sourceOwn: false,
  match: (value) => typeof value === "boolean",
  targetIsSet: (value) => typeof value === "boolean",
  movedMessage: ({ sourcePath, targetPath, mappedValue }) =>
    `Moved ${sourcePath} → ${targetPath} (${String(mappedValue)}).`,
  existingMessage: ({ sourcePath, targetPath, targetValue }) =>
    `Moved ${sourcePath} → ${targetPath} (${String(targetValue)}).`,
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "zalouser", "groups"],
    message:
      'channels.zalouser.groups.<id>.allow is legacy; use channels.zalouser.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => groupAllowMigration.hasLegacy({ groups: value }),
  },
  {
    path: ["channels", "zalouser", "accounts"],
    message:
      'channels.zalouser.accounts.<id>.groups.<id>.allow is legacy; use channels.zalouser.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, groupAllowMigration.hasLegacy),
  },
];

export function normalizeCompatibilityConfig(params: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  return normalizeChannelConfigEntries({
    cfg: params.cfg,
    channelId: "zalouser",
    normalizeEntry: groupAllowMigration.normalize,
  });
}
