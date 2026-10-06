import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { listBuzzDirectoryGroupsFromConfig } from "./directory-config.js";
import { queryBuzzDirectoryProfiles, queryBuzzDirectoryRooms } from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";
import { getActiveBuzzBus } from "./gateway.js";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "./relay-auth.js";
import { queryBuzzRoomMemberships } from "./room-membership-query.js";
import { parseBuzzTarget } from "./target.js";
import {
  assertBuzzAccountAvailable,
  decodeBuzzPrivateKey,
  resolveBuzzAccount,
  resolveBuzzAccountConfig,
} from "./types.js";

const DIRECTORY_LIVE_TIMEOUT_MS = 10_000;

async function loadBuzzDirectoryState(
  params: DirectoryConfigParams,
  refreshRooms: boolean,
): Promise<BuzzDirectoryState | null> {
  const account = resolveBuzzAccount(params);
  if (account.enabled) {
    assertBuzzAccountAvailable(account);
  }
  if (!account.publicKey) {
    return null;
  }
  const channelIds = Object.entries(account.config.groups ?? {})
    .filter(([, config]) => config.enabled !== false)
    .map(([roomId]) => parseBuzzTarget(roomId));
  const state = new BuzzDirectoryState({
    publicKey: account.publicKey,
    fallbackProfileName: account.name ?? "OpenClaw",
    channelIds,
  });
  if (!account.enabled || !account.configured || channelIds.length === 0) {
    return state;
  }
  const activeBus = getActiveBuzzBus(account.accountId);
  if (activeBus) {
    if (refreshRooms) {
      try {
        await activeBus.refreshDirectory();
      } catch {
        // A stalled metadata refresh recycles the relay session. Directory
        // reads can still return the last complete in-memory snapshot.
      }
    }
    return activeBus.directory;
  }

  const timeoutSignal = AbortSignal.timeout(DIRECTORY_LIVE_TIMEOUT_MS);
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: account.relayUrl,
    secretKey: decodeBuzzPrivateKey(account.privateKey),
    authTag: parseBuzzAuthTag(account.authTag),
    signal: timeoutSignal,
  });
  try {
    await queryBuzzDirectoryRooms({
      relay,
      relayPublicKey,
      state,
      channelIds,
      signal: timeoutSignal,
    });
    const activeChannelIds = state.activeRoomIds();
    state.replaceMemberships(
      activeChannelIds.length > 0
        ? await queryBuzzRoomMemberships({
            relay,
            relayPublicKey,
            channelIds: activeChannelIds,
            signal: timeoutSignal,
          })
        : new Map(),
    );
    await queryBuzzDirectoryProfiles({
      relay,
      state,
      publicKeys: state.profilePublicKeys(),
      signal: timeoutSignal,
    });
    return state;
  } finally {
    relay.close();
  }
}

export async function getBuzzDirectorySelf(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry | null> {
  return (await loadBuzzDirectoryState(params, false))?.self() ?? null;
}

export async function listBuzzDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  return (await loadBuzzDirectoryState(params, false))?.listPeers(params) ?? [];
}

export async function listBuzzDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  if (!resolveBuzzAccountConfig(params).config.enabled) {
    return listBuzzDirectoryGroupsFromConfig(params);
  }
  return (await loadBuzzDirectoryState(params, true))?.listGroups(params) ?? [];
}

export async function listBuzzDirectoryGroupMembers(params: {
  cfg: DirectoryConfigParams["cfg"];
  accountId?: string | null;
  groupId: string;
  limit?: number | null;
}): Promise<ChannelDirectoryEntry[]> {
  return (await loadBuzzDirectoryState(params, false))?.listGroupMembers(params) ?? [];
}
