import {
  applyDirectoryQueryAndLimit,
  collectNormalizedDirectoryIds,
  inspectReadOnlyChannelAccount,
  listDirectoryGroupEntriesFromMapKeys,
  toDirectoryEntries,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import type { InspectedSlackAccount } from "../api.js";
import { parseSlackTarget } from "./targets.js";

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
      const normalized = parseSlackTarget(target, { defaultKind: "user" });
      return normalized?.kind === "user" ? `user:${normalized.id.toLowerCase()}` : null;
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
      const normalized = parseSlackTarget(raw, { defaultKind: "channel" });
      return normalized?.kind === "channel" ? `channel:${normalized.id.toLowerCase()}` : null;
    },
  });
}
