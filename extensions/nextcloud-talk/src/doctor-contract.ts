// Nextcloud Talk plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../runtime-api.js";

const NEXTCLOUD_TALK_CONFIG_PATH = "channels.nextcloud-talk";
const PRIVATE_NETWORK_REMOVAL_MESSAGE =
  "Nextcloud Talk private-network fetch enforcement moved to proxy.enabled plus external proxy policy.";

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
    path: ["channels", "nextcloud-talk"],
    message: `${NEXTCLOUD_TALK_CONFIG_PATH} private-network config is retired. Run "openclaw doctor --fix".`,
    match: hasRetiredPrivateNetworkConfig,
  },
  {
    path: ["channels", "nextcloud-talk", "accounts"],
    message: `${NEXTCLOUD_TALK_CONFIG_PATH}.accounts.<id> private-network config is retired. Run "openclaw doctor --fix".`,
    match: hasRetiredPrivateNetworkConfigInAccounts,
  },
];

export function normalizeCompatibilityConfig(params: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const channels = isRecord(params.cfg.channels) ? params.cfg.channels : null;
  const nextcloudTalk = isRecord(channels?.["nextcloud-talk"]) ? channels["nextcloud-talk"] : null;
  if (!nextcloudTalk) {
    return { config: params.cfg, changes: [] };
  }

  const changes: string[] = [];
  let updatedNextcloudTalk = nextcloudTalk;
  let changed = false;

  const topLevel = removeRetiredPrivateNetworkConfig({
    entry: updatedNextcloudTalk,
    pathPrefix: NEXTCLOUD_TALK_CONFIG_PATH,
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
      const removed = removeRetiredPrivateNetworkConfig({
        entry: account,
        pathPrefix: `${NEXTCLOUD_TALK_CONFIG_PATH}.accounts.${accountId}`,
        changes,
      });
      if (!removed.changed) {
        continue;
      }
      nextAccounts[accountId] = removed.entry;
      accountsChanged = true;
    }
    if (accountsChanged) {
      updatedNextcloudTalk = { ...updatedNextcloudTalk, accounts: nextAccounts };
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
        "nextcloud-talk": updatedNextcloudTalk,
      },
    },
    changes,
  };
}
