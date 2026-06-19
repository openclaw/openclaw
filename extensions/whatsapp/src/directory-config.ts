// Whatsapp helper module supports directory config behavior.
import {
  listResolvedDirectoryGroupEntriesFromMapKeys,
  listResolvedDirectoryUserEntriesFromAllowFrom,
  type ChannelDirectoryEntry,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-config-runtime";
import { resolveMergedWhatsAppAccountConfig } from "./account-config.js";
import type { WhatsAppAccountConfig } from "./account-types.js";
import { resolveWebAccountId } from "./active-listener.js";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

type WhatsAppDirectoryAccount = WhatsAppAccountConfig & { accountId: string };

function resolveWhatsAppDirectoryAccount(
  cfg: DirectoryConfigParams["cfg"],
  accountId?: string | null,
): WhatsAppDirectoryAccount {
  return resolveMergedWhatsAppAccountConfig({ cfg, accountId });
}

export async function listWhatsAppDirectoryPeersFromConfig(params: DirectoryConfigParams) {
  return listResolvedDirectoryUserEntriesFromAllowFrom<WhatsAppDirectoryAccount>({
    ...params,
    resolveAccount: resolveWhatsAppDirectoryAccount,
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
  return listResolvedDirectoryGroupEntriesFromMapKeys<WhatsAppDirectoryAccount>({
    ...params,
    resolveAccount: resolveWhatsAppDirectoryAccount,
    resolveGroups: (account) => account.groups,
  });
}

export async function listWhatsAppDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const accountId = resolveWebAccountId({ cfg: params.cfg, accountId: params.accountId });
  const controller = getRegisteredWhatsAppConnectionController(accountId);
  const sock = controller?.getCurrentSock() ?? null;

  if (!sock) {
    return listWhatsAppDirectoryGroupsFromConfig(params);
  }

  let groups: Record<string, { id: string; subject?: string } | undefined>;
  try {
    groups = (await sock.groupFetchAllParticipating()) ?? {};
  } catch {
    return listWhatsAppDirectoryGroupsFromConfig(params);
  }

  const query = params.query?.toLowerCase() ?? "";
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
  const entries: ChannelDirectoryEntry[] = [];

  for (const [jid, meta] of Object.entries(groups)) {
    const name = meta?.subject?.trim() || undefined;
    const lowerJid = jid.toLowerCase();

    if (query) {
      const lowerName = name?.toLowerCase() ?? "";
      if (!lowerJid.includes(query) && !lowerName.includes(query)) {
        continue;
      }
    }

    entries.push({ kind: "group" as const, id: jid, name });

    if (typeof limit === "number" && entries.length >= limit) {
      break;
    }
  }

  return entries;
}
