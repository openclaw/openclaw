import { type ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { collectProviderDangerousNameMatchingScopes } from "openclaw/plugin-sdk/runtime-doctor";
import {
  legacyConfigRules as SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeSlackCompatibilityConfig,
} from "./doctor-contract.js";
import { isSlackMutableAllowEntry } from "./security-doctor.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizeForLog(value: string): string {
  return value.replace(/\p{Cc}+/gu, " ").trim();
}
export function collectSlackMutableAllowlistWarnings(cfg: OpenClawConfig): string[] {
  const hits: Array<{ path: string; entry: string }> = [];
  const addHits = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list) {
      const text = String(entry).trim();
      if (!text || text === "*" || !isSlackMutableAllowEntry(text)) {
        continue;
      }
      hits.push({ path: pathLabel, entry: text });
    }
  };

  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "slack")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    addHits(`${scope.prefix}.allowFrom`, scope.account.allowFrom);
    const dm = asObjectRecord(scope.account.dm);
    if (dm) {
      addHits(`${scope.prefix}.dm.allowFrom`, dm.allowFrom);
    }
    const channels = asObjectRecord(scope.account.channels);
    if (!channels) {
      continue;
    }
    for (const [channelKey, channelRaw] of Object.entries(channels)) {
      const channel = asObjectRecord(channelRaw);
      if (channel) {
        addHits(`${scope.prefix}.channels.${channelKey}.users`, channel.users);
      }
    }
  }

  if (hits.length === 0) {
    return [];
  }
  const exampleLines = hits
    .slice(0, 8)
    .map((hit) => `- ${sanitizeForLog(hit.path)}: ${sanitizeForLog(hit.entry)}`);
  const remaining =
    hits.length > 8 ? `- +${hits.length - 8} more mutable allowlist entries.` : null;
  return [
    `- Found ${hits.length} mutable allowlist ${hits.length === 1 ? "entry" : "entries"} across slack while name matching is disabled by default.`,
    ...exampleLines,
    ...(remaining ? [remaining] : []),
    "- Option A (break-glass): enable channels.slack.dangerousNameMatching=true for the affected scope.",
    "- Option B (recommended): resolve names to stable Slack IDs and rewrite the allowlist entries.",
  ];
}

export const slackDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOrNested",
  groupModel: "route",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules: SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeSlackCompatibilityConfig,
  collectMutableAllowlistWarnings: ({ cfg }) => collectSlackMutableAllowlistWarnings(cfg),
};
