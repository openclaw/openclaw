import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  hasLegacyFlatAllowPrivateNetworkAlias,
  migrateLegacyFlatAllowPrivateNetworkAlias,
} from "openclaw/plugin-sdk/ssrf-runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasLegacyAllowPrivateNetworkInAccounts(value: unknown): boolean {
  const accounts = isRecord(value) ? value : null;
  return Boolean(
    accounts &&
    Object.values(accounts).some((account) =>
      hasLegacyFlatAllowPrivateNetworkAlias(isRecord(account) ? account : {}),
    ),
  );
}

function normalizeNextcloudTalkCompatibilityConfig(
  cfg: OpenClawConfig,
): ChannelDoctorConfigMutation {
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  const nextcloudTalk = isRecord(channels?.["nextcloud-talk"]) ? channels["nextcloud-talk"] : null;
  if (!nextcloudTalk) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updatedNextcloudTalk = nextcloudTalk;
  let changed = false;

  const topLevel = migrateLegacyFlatAllowPrivateNetworkAlias({
    entry: updatedNextcloudTalk,
    pathPrefix: "channels.nextcloud-talk",
    changes,
  });
  updatedNextcloudTalk = topLevel.entry;
  changed = changed || topLevel.changed;

  const accounts = isRecord(updatedNextcloudTalk.accounts) ? updatedNextcloudTalk.accounts : null;
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts: Record<string, unknown> = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = isRecord(accountValue) ? accountValue : null;
      if (!account) {
        continue;
      }
      const migrated = migrateLegacyFlatAllowPrivateNetworkAlias({
        entry: account,
        pathPrefix: `channels.nextcloud-talk.accounts.${accountId}`,
        changes,
      });
      if (!migrated.changed) {
        continue;
      }
      nextAccounts[accountId] = migrated.entry;
      accountsChanged = true;
    }
    if (accountsChanged) {
      updatedNextcloudTalk = { ...updatedNextcloudTalk, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }

  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        "nextcloud-talk": updatedNextcloudTalk as NonNullable<
          OpenClawConfig["channels"]
        >["nextcloud-talk"],
      },
    },
    changes,
  };
}

const NEXTCLOUD_TALK_LEGACY_CONFIG_RULES: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "nextcloud-talk"],
    message:
      'channels.nextcloud-talk.allowPrivateNetwork is legacy; use channels.nextcloud-talk.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(value) ? value : {}),
  },
  {
    path: ["channels", "nextcloud-talk", "accounts"],
    message:
      'channels.nextcloud-talk.accounts.<id>.allowPrivateNetwork is legacy; use channels.nextcloud-talk.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    match: hasLegacyAllowPrivateNetworkInAccounts,
  },
];

export const nextcloudTalkDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: ({ cfg }) => normalizeNextcloudTalkCompatibilityConfig(cfg),
};
