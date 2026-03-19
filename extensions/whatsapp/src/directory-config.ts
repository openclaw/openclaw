import {
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

export async function listWhatsAppDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryUserEntriesFromAllowFrom({
    ...params,
    resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
    resolveAllowFrom: (account) => account.allowFrom,
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
  return listResolvedDirectoryGroupEntriesFromMapKeys({
    ...params,
    resolveAccount: (cfg, accountId) => resolveWhatsAppAccount({ cfg, accountId }),
    resolveGroups: (account) => account.groups,
  });
}
