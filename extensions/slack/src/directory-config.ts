import {
  applyDirectoryQueryAndLimit,
  collectNormalizedDirectoryIds,
  listDirectoryGroupEntriesFromMapKeys,
  toDirectoryEntries,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { normalizeSlackMessagingTarget } from "../../../src/channels/plugins/normalize/slack.js";
import { inspectReadOnlyChannelAccount } from "../../../src/channels/read-only-account-inspect.js";
import type { InspectedSlackAccount } from "../../../src/channels/read-only-account-inspect.slack.runtime.js";

export async function listSlackDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  const account = (await inspectReadOnlyChannelAccount({
    channelId: "slack",
    cfg: params.cfg,
    accountId: params.accountId,
  })) as InspectedSlackAccount | null;
  if (!account || !("config" in account)) {
    return [];
  }

  const allowFrom = account.config.allowFrom ?? account.dm?.allowFrom ?? [];
  const channelUsers = Object.values(account.config.channels ?? {}).flatMap(
    (channel) => channel.users ?? [],
  );
  const ids = collectNormalizedDirectoryIds({
    sources: [allowFrom, Object.keys(account.config.dms ?? {}), channelUsers],
    normalizeId: (raw) => {
      const mention = raw.match(/^<@([A-Z0-9]+)>$/i);
      const normalizedUserId = (mention?.[1] ?? raw).replace(/^(slack|user):/i, "").trim();
      if (!normalizedUserId) {
        return null;
      }
      const target = `user:${normalizedUserId}`;
      const normalized = normalizeSlackMessagingTarget(target) ?? target.toLowerCase();
      return normalized.startsWith("user:") ? normalized : null;
    },
  });
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export async function listSlackDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  const account = (await inspectReadOnlyChannelAccount({
    channelId: "slack",
    cfg: params.cfg,
    accountId: params.accountId,
  })) as InspectedSlackAccount | null;
  if (!account || !("config" in account)) {
    return [];
  }
  return listDirectoryGroupEntriesFromMapKeys({
    groups: account.config.channels,
    query: params.query,
    limit: params.limit,
    normalizeId: (raw) => {
      const normalized = normalizeSlackMessagingTarget(raw) ?? raw.toLowerCase();
      return normalized.startsWith("channel:") ? normalized : null;
    },
  });
}
