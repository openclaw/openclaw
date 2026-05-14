import { type ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { resolveDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import {
  legacyConfigRules as SLACK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeSlackCompatibilityConfig,
} from "./doctor-contract.js";
import {
  collectIgnoredSlackChannelRouteKeys,
  formatIgnoredSlackChannelRouteKeyWarning,
} from "./monitor/channel-config.js";
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

export function collectSlackIgnoredChannelRouteKeyWarnings(params: {
  cfg: Record<string, unknown>;
}): string[] {
  const slack = asObjectRecord(asObjectRecord(params.cfg.channels)?.slack);
  if (!slack) {
    return [];
  }
  const warnings: string[] = [];
  const topGroupPolicy = typeof slack.groupPolicy === "string" ? slack.groupPolicy : undefined;
  const topAllowNameMatching = slack.dangerouslyAllowNameMatching === true;
  const topChannels = asObjectRecord(slack.channels);
  if (topChannels) {
    for (const key of collectIgnoredSlackChannelRouteKeys({
      channels: topChannels as never,
      groupPolicy: topGroupPolicy,
      allowNameMatching: topAllowNameMatching,
    })) {
      warnings.push(
        formatIgnoredSlackChannelRouteKeyWarning({
          path: "channels.slack.channels",
          key,
        }),
      );
    }
  }

  const accounts = asObjectRecord(slack.accounts);
  if (!accounts) {
    return warnings;
  }
  for (const [accountId, rawAccount] of Object.entries(accounts)) {
    const account = asObjectRecord(rawAccount);
    if (!account) {
      continue;
    }
    const accountChannels = asObjectRecord(account.channels);
    if (!accountChannels) {
      continue;
    }
    const accountGroupPolicy =
      typeof account.groupPolicy === "string" ? account.groupPolicy : topGroupPolicy;
    const accountAllowNameMatching = resolveDangerousNameMatchingEnabled({
      providerConfig: slack,
      accountConfig: account,
    });
    for (const key of collectIgnoredSlackChannelRouteKeys({
      channels: accountChannels as never,
      groupPolicy: accountGroupPolicy,
      allowNameMatching: accountAllowNameMatching,
    })) {
      warnings.push(
        formatIgnoredSlackChannelRouteKeyWarning({
          path: `channels.slack.accounts.${accountId}.channels`,
          key,
        }),
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
  collectPreviewWarnings: ({ cfg }) => collectSlackIgnoredChannelRouteKeyWarnings({ cfg }),
  collectMutableAllowlistWarnings: collectSlackMutableAllowlistWarnings,
};
