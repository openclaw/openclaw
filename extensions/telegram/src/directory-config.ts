import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  applyDirectoryQueryAndLimit,
  collectNormalizedDirectoryIds,
  listDirectoryGroupEntriesFromMapKeys,
  toDirectoryEntries,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { inspectTelegramAccount, type InspectedTelegramAccount } from "../api.js";

export async function listTelegramDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  const account: InspectedTelegramAccount = inspectTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!account.config) {
    return [];
  }

  const ids = collectNormalizedDirectoryIds({
    sources: [mapAllowFromEntries(account.config.allowFrom), Object.keys(account.config.dms ?? {})],
    normalizeId: (entry) => {
      const trimmed = entry.replace(/^(telegram|tg):/i, "").trim();
      if (!trimmed) {
        return null;
      }
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
      return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    },
  });
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

export async function listTelegramDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  const account: InspectedTelegramAccount = inspectTelegramAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!account.config) {
    return [];
  }
  return listDirectoryGroupEntriesFromMapKeys({
    groups: account.config.groups,
    query: params.query,
    limit: params.limit,
  });
}
