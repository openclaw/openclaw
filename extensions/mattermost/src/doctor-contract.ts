// Mattermost plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "./runtime-api.js";

const MATTERMOST_CONFIG_PATH = "channels.mattermost";
const PRIVATE_NETWORK_REMOVAL_MESSAGE =
  "Mattermost private-network fetch enforcement moved to proxy.enabled plus external proxy policy.";

function hasRetiredPrivateNetworkConfig(value: unknown): boolean {
  const record = isRecord(value) ? value : null;
  const network = isRecord(record?.network) ? record.network : null;
  return Boolean(
    record &&
    (Object.hasOwn(record, "allowPrivateNetwork") ||
      Object.hasOwn(record, "dangerouslyAllowPrivateNetwork") ||
      (network && Object.hasOwn(network, "dangerouslyAllowPrivateNetwork"))),
  );
}

function hasRetiredPrivateNetworkConfigInAccounts(value: unknown): boolean {
  const accounts = isRecord(value) ? value : null;
  return Boolean(
    accounts && Object.values(accounts).some((account) => hasRetiredPrivateNetworkConfig(account)),
  );
}

function removeRetiredPrivateNetworkConfig(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const nextEntry = { ...params.entry };
  let changed = false;

  if (Object.hasOwn(nextEntry, "allowPrivateNetwork")) {
    delete nextEntry.allowPrivateNetwork;
    changed = true;
  }
  if (Object.hasOwn(nextEntry, "dangerouslyAllowPrivateNetwork")) {
    delete nextEntry.dangerouslyAllowPrivateNetwork;
    changed = true;
  }

  const network = isRecord(nextEntry.network) ? { ...nextEntry.network } : null;
  if (network && Object.hasOwn(network, "dangerouslyAllowPrivateNetwork")) {
    delete network.dangerouslyAllowPrivateNetwork;
    changed = true;
    if (Object.keys(network).length > 0) {
      nextEntry.network = network;
    } else {
      delete nextEntry.network;
    }
  }

  if (changed) {
    params.changes.push(
      `Removed ${params.pathPrefix} private-network config. ${PRIVATE_NETWORK_REMOVAL_MESSAGE}`,
    );
  }
  return { entry: nextEntry, changed };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "mattermost"],
    message: `${MATTERMOST_CONFIG_PATH} private-network config is retired. Run "openclaw doctor --fix".`,
    match: hasRetiredPrivateNetworkConfig,
  },
  {
    path: ["channels", "mattermost", "accounts"],
    message: `${MATTERMOST_CONFIG_PATH}.accounts.<id> private-network config is retired. Run "openclaw doctor --fix".`,
    match: hasRetiredPrivateNetworkConfigInAccounts,
  },
];

export function normalizeCompatibilityConfig(params: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const channels = isRecord(params.cfg.channels) ? params.cfg.channels : null;
  const mattermost = isRecord(channels?.mattermost) ? channels.mattermost : null;
  if (!mattermost) {
    return { config: params.cfg, changes: [] };
  }

  const changes: string[] = [];
  let updatedMattermost = mattermost;
  let changed = false;

  const topLevel = removeRetiredPrivateNetworkConfig({
    entry: updatedMattermost,
    pathPrefix: MATTERMOST_CONFIG_PATH,
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
      const removed = removeRetiredPrivateNetworkConfig({
        entry: account,
        pathPrefix: `${MATTERMOST_CONFIG_PATH}.accounts.${accountId}`,
        changes,
      });
      if (!removed.changed) {
        continue;
      }
      nextAccounts[accountId] = removed.entry;
      accountsChanged = true;
    }
    if (accountsChanged) {
      updatedMattermost = { ...updatedMattermost, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed) {
    return { config: params.cfg, changes: [] };
  }

  return {
    config: {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        mattermost: updatedMattermost,
      },
    },
    changes,
  };
}
