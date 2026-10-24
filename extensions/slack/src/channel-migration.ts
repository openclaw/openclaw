import type { OpenClawConfig, SlackChannelConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId, resolveAccountEntry } from "openclaw/plugin-sdk/routing";

type SlackChannels = Record<string, SlackChannelConfig>;

type SlackChannelMigrationResult = {
  migrated: boolean;
  skippedExisting: boolean;
};

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
    params.accountId
      ? resolveAccountEntry(
          params.cfg.channels?.slack?.accounts,
          normalizeAccountId(params.accountId),
        )?.channels
      : undefined,
    params.cfg.channels?.slack?.channels,
  ]) {
    const result = migrateSlackChannelsInPlace(channels, params.oldChannelId, params.newChannelId);
    migrated ||= result.migrated;
    skippedExisting ||= result.skippedExisting;
  }

  return { migrated, skippedExisting };
}
