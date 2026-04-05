import type {
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

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "bluebubbles"],
    message:
      "channels.bluebubbles.allowPrivateNetwork is legacy; use channels.bluebubbles.network.dangerouslyAllowPrivateNetwork instead (auto-migrated on load).",
    match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(value) ? value : {}),
  },
  {
    path: ["channels", "bluebubbles", "accounts"],
    message:
      "channels.bluebubbles.accounts.<id>.allowPrivateNetwork is legacy; use channels.bluebubbles.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead (auto-migrated on load).",
    match: hasLegacyAllowPrivateNetworkInAccounts,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  const bluebubbles = isRecord(channels?.bluebubbles) ? channels.bluebubbles : null;
  if (!bluebubbles) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updatedBluebubbles = bluebubbles;
  let changed = false;

  const topLevel = migrateLegacyFlatAllowPrivateNetworkAlias({
    entry: updatedBluebubbles,
    pathPrefix: "channels.bluebubbles",
    changes,
  });
  updatedBluebubbles = topLevel.entry;
  changed = changed || topLevel.changed;

  const accounts = isRecord(updatedBluebubbles.accounts) ? updatedBluebubbles.accounts : null;
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
        pathPrefix: `channels.bluebubbles.accounts.${accountId}`,
        changes,
      });
      if (!migrated.changed) {
        continue;
      }
      nextAccounts[accountId] = migrated.entry;
      accountsChanged = true;
    }
    if (accountsChanged) {
      updatedBluebubbles = { ...updatedBluebubbles, accounts: nextAccounts };
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
        bluebubbles: updatedBluebubbles as NonNullable<OpenClawConfig["channels"]>["bluebubbles"],
      },
    },
    changes,
  };
}
