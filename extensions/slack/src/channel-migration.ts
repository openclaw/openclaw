import type { OpenClawConfig, SlackChannelConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type SlackChannels = Record<string, SlackChannelConfig>;

type SlackChannelMigrationResult = {
  migrated: boolean;
  skippedExisting: boolean;
};

function resolveAccountChannels(
  cfg: OpenClawConfig,
  accountId?: string | null,
): { channels?: SlackChannels } {
  if (!accountId) {
    return {};
  }
  const normalized = normalizeAccountId(accountId);
  const accounts = cfg.channels?.slack?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return {};
  }
  const exact = accounts[normalized];
  if (exact?.channels) {
    return { channels: exact.channels };
  }
  const matchKey = Object.keys(accounts).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === normalizeLowercaseStringOrEmpty(normalized),
  );
  return { channels: matchKey ? accounts[matchKey]?.channels : undefined };
}

function migrateSlackChannelsInPlace(
  channels: SlackChannels | undefined,
  oldChannelId: string,
  newChannelId: string,
): { migrated: boolean; skippedExisting: boolean } {
  if (!channels || oldChannelId === newChannelId || !Object.hasOwn(channels, oldChannelId)) {
    return { migrated: false, skippedExisting: false };
  }
  if (Object.hasOwn(channels, newChannelId)) {
    return { migrated: false, skippedExisting: true };
  }
  const channelConfig = channels[oldChannelId];
  if (!channelConfig) {
    return { migrated: false, skippedExisting: false };
  }
  channels[newChannelId] = channelConfig;
  delete channels[oldChannelId];
  return { migrated: true, skippedExisting: false };
}

export function migrateSlackChannelConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  oldChannelId: string;
  newChannelId: string;
}): SlackChannelMigrationResult {
  let migrated = false;
  let skippedExisting = false;
  for (const channels of [
    resolveAccountChannels(params.cfg, params.accountId).channels,
    params.cfg.channels?.slack?.channels,
  ]) {
    const result = migrateSlackChannelsInPlace(channels, params.oldChannelId, params.newChannelId);
    migrated ||= result.migrated;
    skippedExisting ||= result.skippedExisting;
  }

  return { migrated, skippedExisting };
}
