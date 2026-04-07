import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  legacyConfigRules as MATTERMOST_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeMattermostCompatibilityConfig,
} from "./doctor-contract.js";

function isMattermostMutableAllowEntry(raw: string): boolean {
  const text = raw.trim();
  if (!text || text === "*") {
    return false;
  }

  const normalized = text
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();

  if (/^[a-z0-9]{26}$/.test(normalized)) {
    return false;
  }

  return true;
}

export const collectMattermostMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "mattermost",
    detector: isMattermostMutableAllowEntry,
    collectLists: (scope) => [
      {
        pathLabel: `${scope.prefix}.allowFrom`,
        list: scope.account.allowFrom,
      },
      {
        pathLabel: `${scope.prefix}.groupAllowFrom`,
        list: scope.account.groupAllowFrom,
      },
    ],
  });

export const mattermostDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: MATTERMOST_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeMattermostCompatibilityConfig,
  collectMutableAllowlistWarnings: collectMattermostMutableAllowlistWarnings,
};
