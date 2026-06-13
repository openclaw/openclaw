// Slack plugin module implements doctor behavior.
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { collectProviderDangerousNameMatchingScopes } from "openclaw/plugin-sdk/runtime-doctor";
import { resolveDefaultGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
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

const collectSlackMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "slack",
    detector: isSlackMutableAllowEntry,
    collectLists: (scope) => {
      const lists = [
        {
          pathLabel: `${scope.prefix}.allowFrom`,
          list: scope.account.allowFrom,
        },
      ];
      const dm = asObjectRecord(scope.account.dm);
      if (dm) {
        lists.push({
          pathLabel: `${scope.prefix}.dm.allowFrom`,
          list: dm.allowFrom,
        });
      }
      const channels = asObjectRecord(scope.account.channels);
      if (channels) {
        for (const [channelKey, channelRaw] of Object.entries(channels)) {
          const channel = asObjectRecord(channelRaw);
          if (!channel) {
            continue;
          }
          lists.push({
            pathLabel: `${scope.prefix}.channels.${channelKey}.users`,
            list: channel.users,
          });
        }
      }
      return lists;
    },
  });

// Match every ID form accepted by Slack channel routing, including normalized config keys.
const SLACK_CHANNEL_ID_RE = /^(?:channel:)?[CGD][A-Z0-9]{8,}$/i;

function collectSlackNameKeyedChannelWarnings({ cfg }: { cfg: OpenClawConfig }): string[] {
  const warnings: string[] = [];
  const slackCfg = asObjectRecord(asObjectRecord(cfg.channels)?.slack);
  const providerGroupPolicy =
    slackCfg && typeof slackCfg.groupPolicy === "string"
      ? (slackCfg.groupPolicy as GroupPolicy)
      : undefined;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  for (const scope of collectProviderDangerousNameMatchingScopes(cfg, "slack")) {
    if (scope.dangerousNameMatchingEnabled) {
      continue;
    }
    const scopedGroupPolicy =
      typeof scope.account.groupPolicy === "string"
        ? (scope.account.groupPolicy as GroupPolicy)
        : providerGroupPolicy;
    // Doctor reads authored config, while Slack's runtime schema materializes this default.
    const effectiveGroupPolicy = scopedGroupPolicy ?? defaultGroupPolicy ?? "allowlist";
    if (effectiveGroupPolicy !== "allowlist") {
      continue;
    }
    const channels = asObjectRecord(scope.account.channels);
    if (!channels) {
      continue;
    }
    for (const channelKey of Object.keys(channels)) {
      if (channelKey === "*" || SLACK_CHANNEL_ID_RE.test(channelKey)) {
        continue;
      }
      warnings.push(
        `${scope.prefix}.channels."${channelKey}" is keyed by a channel name, not a Slack channel ID; ` +
          `under groupPolicy: "allowlist" this entry never matches and messages in that channel are silently dropped. ` +
          `Re-key it with the channel's ID (e.g. C0123ABCD, from the channel's About details or conversations.info).`,
      );
    }
  }
  return warnings;
}

export const slackDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  groupModel: "route",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules: SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeSlackCompatibilityConfig,
  collectMutableAllowlistWarnings: ({ cfg }) => [
    ...collectSlackMutableAllowlistWarnings({ cfg }),
    ...collectSlackNameKeyedChannelWarnings({ cfg }),
  ],
};
