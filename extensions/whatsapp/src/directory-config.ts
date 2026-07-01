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
import { readWebAuthExistsForDecision } from "./auth-store.js";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";
import { createWaSocket, waitForWaConnection } from "./session.js";

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

type GroupFetchSocket = {
  groupFetchAllParticipating(): Promise<
    Record<string, { id: string; subject?: string } | undefined>
  >;
};

async function fetchLiveGroups(
  sock: GroupFetchSocket,
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const groups = (await sock.groupFetchAllParticipating()) ?? {};

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

export async function listWhatsAppDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const accountId = resolveWebAccountId({ cfg: params.cfg, accountId: params.accountId });
  const controller = getRegisteredWhatsAppConnectionController(accountId);
  const controllerSock = controller?.getCurrentSock() ?? null;

  // Process-local socket (gateway process).
  if (controllerSock) {
    try {
      return await fetchLiveGroups(controllerSock, params);
    } catch {
      return listWhatsAppDirectoryGroupsFromConfig(params);
    }
  }

  // Standalone path for CLI consumers: open a temporary socket using stored
  // auth credentials, fetch groups, then close. Without this the standalone
  // `openclaw directory groups list --channel whatsapp` CLI only sees
  // config-backed groups because no gateway process-local controller exists.
  const account = resolveMergedWhatsAppAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const authDir = account.authDir;
  if (!authDir) {
    return listWhatsAppDirectoryGroupsFromConfig(params);
  }

  const authState = await readWebAuthExistsForDecision(authDir);
  if (!("exists" in authState) || !authState.exists) {
    return listWhatsAppDirectoryGroupsFromConfig(params);
  }

  let standaloneSock: Awaited<ReturnType<typeof createWaSocket>> | undefined;
  try {
    standaloneSock = await createWaSocket(false, false, { authDir });
    await waitForWaConnection(standaloneSock, { timeoutMs: 30_000 });
    return await fetchLiveGroups(standaloneSock, params);
  } catch {
    return listWhatsAppDirectoryGroupsFromConfig(params);
  } finally {
    if (standaloneSock) {
      try {
        standaloneSock.end?.(new Error("OpenClaw WhatsApp standalone directory socket close"));
      } catch {
        // best-effort cleanup
      }
    }
  }
}
