import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId, resolveAccountEntry } from "openclaw/plugin-sdk/routing";

export function migrateSlackChannelConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  oldChannelId: string;
  newChannelId: string;
}) {
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
    const { oldChannelId, newChannelId } = params;
    if (!channels || oldChannelId === newChannelId || !Object.hasOwn(channels, oldChannelId)) {
      continue;
    }
    if (Object.hasOwn(channels, newChannelId)) {
      skippedExisting = true;
      continue;
    }
    const channelConfig = channels[oldChannelId];
    if (!channelConfig) {
      continue;
    }
    channels[newChannelId] = channelConfig;
    delete channels[oldChannelId];
    migrated = true;
  }

  return { migrated, skippedExisting };
}
