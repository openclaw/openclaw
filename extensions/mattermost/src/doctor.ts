import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  hasLegacyFlatAllowPrivateNetworkAlias,
  migrateLegacyFlatAllowPrivateNetworkAlias,
} from "openclaw/plugin-sdk/ssrf-runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

function hasLegacyMattermostAllowPrivateNetworkInAccounts(value: unknown): boolean {
  const accounts = isRecord(value) ? value : null;
  return Boolean(
    accounts &&
    Object.values(accounts).some((account) =>
      hasLegacyFlatAllowPrivateNetworkAlias(isRecord(account) ? account : {}),
    ),
  );
}

export const MATTERMOST_LEGACY_CONFIG_RULES: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "mattermost"],
    message:
      'channels.mattermost.allowPrivateNetwork is legacy; use channels.mattermost.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(value) ? value : {}),
  },
  {
    path: ["channels", "mattermost", "accounts"],
    message:
      'channels.mattermost.accounts.<id>.allowPrivateNetwork is legacy; use channels.mattermost.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    match: hasLegacyMattermostAllowPrivateNetworkInAccounts,
  },
];

export function normalizeMattermostCompatibilityConfig(
  cfg: OpenClawConfig,
): ChannelDoctorConfigMutation {
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  const mattermost = isRecord(channels?.mattermost) ? channels.mattermost : null;
  if (!mattermost) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updatedMattermost = mattermost;
  let changed = false;

  const topLevel = migrateLegacyFlatAllowPrivateNetworkAlias({
    entry: updatedMattermost,
    pathPrefix: "channels.mattermost",
    changes,
  });
  updatedMattermost = topLevel.entry;
  changed = changed || topLevel.changed;

  const accounts = isRecord(updatedMattermost.accounts) ? updatedMattermost.accounts : null;
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
        pathPrefix: `channels.mattermost.accounts.${accountId}`,
        changes,
      });
      if (!migrated.changed) {
        continue;
      }
      nextAccounts[accountId] = migrated.entry;
      accountsChanged = true;
    }
    if (accountsChanged) {
      updatedMattermost = { ...updatedMattermost, accounts: nextAccounts };
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
        mattermost: updatedMattermost as NonNullable<OpenClawConfig["channels"]>["mattermost"],
      },
    },
    changes,
  };
}

export const mattermostDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: MATTERMOST_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: ({ cfg }) => normalizeMattermostCompatibilityConfig(cfg),
  collectMutableAllowlistWarnings: collectMattermostMutableAllowlistWarnings,
};
