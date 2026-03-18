import {
  listDirectoryGroupEntriesFromMapKeys,
  listDirectoryUserEntriesFromAllowFrom,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

export async function listWhatsAppDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  return listDirectoryUserEntriesFromAllowFrom({
    allowFrom: account.allowFrom,
    query: params.query,
    limit: params.limit,
    normalizeId: (entry) => {
      const normalized = normalizeWhatsAppTarget(entry);
      if (!normalized || isWhatsAppGroupJid(normalized)) {
        return null;
      }
      return normalized;
    },
  });
}

export async function listWhatsAppDirectoryGroupsFromConfig(params: DirectoryConfigParams) {
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId });
  return listDirectoryGroupEntriesFromMapKeys({
    groups: account.groups,
    query: params.query,
    limit: params.limit,
  });
}
