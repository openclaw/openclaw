import type { Event, Filter, Relay } from "nostr-tools";
import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import {
  BUZZ_PROFILE_KIND,
  BUZZ_PROFILE_QUERY_CHUNK_SIZE,
  BUZZ_ROOM_METADATA_KIND,
  type BuzzDirectoryState,
} from "./directory-state.js";
import { openBuzzRelaySubscription, queryBuzzRelaySnapshot } from "./relay-subscription.js";

const BUZZ_ROOM_QUERY_CHUNK_SIZE = 1_000;
const PROFILE_SUBSCRIPTION_REPLACED_REASON = "directory profile subscription replaced";
const PROFILE_SUBSCRIPTION_FAILED_REASON = "directory profile subscription generation failed";
const DIRECTORY_SHUTDOWN_REASON = "directory shutdown";
const DIRECTORY_QUERY_COMPLETE_REASON = "directory query complete";

type BuzzSubscription = ReturnType<Relay["prepareSubscription"]>;

async function queryBuzzDirectoryBatch(params: {
  relay: Relay;
  filter: Filter;
  onEvent: (event: Event) => void;
  onTimeout?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<void> {
  params.signal?.throwIfAborted();
  await queryBuzzRelaySnapshot({
    relay: params.relay,
    filters: [params.filter],
    signal: params.signal,
    timeoutMessage: "Timed out loading Buzz directory snapshot",
    abortMessage: "Buzz directory query aborted",
    failureMessage: "Buzz directory query failed",
    closeReason: DIRECTORY_QUERY_COMPLETE_REASON,
    closeMessage: (reason) => `Buzz directory query closed: ${reason}`,
    onEvent: params.onEvent,
    result: () => {},
    onTimeout: params.onTimeout,
    closeRelayOnTimeout: !params.onTimeout,
  });
}

export async function queryBuzzDirectoryProfiles(params: {
  relay: Relay;
  state: BuzzDirectoryState;
  publicKeys: string[];
  signal?: AbortSignal;
}): Promise<void> {
  for (const authors of chunkItems(params.publicKeys, BUZZ_PROFILE_QUERY_CHUNK_SIZE)) {
    await queryBuzzDirectoryBatch({
      relay: params.relay,
      filter: {
        kinds: [BUZZ_PROFILE_KIND],
        authors,
        limit: authors.length,
      },
      onEvent: (event) => {
        params.state.applyProfileEvent(event);
      },
      signal: params.signal,
    });
  }
}

export async function queryBuzzDirectoryRooms(params: {
  relay: Relay;
  relayPublicKey: string;
  state: BuzzDirectoryState;
  channelIds: string[];
  onRoomChanged?: () => void;
  onTimeout?: (error: Error) => void;
  signal?: AbortSignal;
}): Promise<void> {
  for (const roomIds of chunkItems(params.channelIds, BUZZ_ROOM_QUERY_CHUNK_SIZE)) {
    await queryBuzzDirectoryBatch({
      relay: params.relay,
      filter: {
        kinds: [BUZZ_ROOM_METADATA_KIND],
        authors: [params.relayPublicKey],
        "#d": roomIds,
        limit: roomIds.length,
      },
      onEvent: (event) => {
        if (
          event.pubkey.toLowerCase() === params.relayPublicKey &&
          params.state.applyRoomEvent(event)
        ) {
          params.onRoomChanged?.();
        }
      },
      onTimeout: params.onTimeout,
      signal: params.signal,
    });
  }
}

export function startBuzzDirectoryRelay(params: {
  relay: Relay;
  relayPublicKey: string;
  state: BuzzDirectoryState;
  subscribedRoomIds?: ReadonlySet<string>;
  signal?: AbortSignal;
  onError?: (error: Error) => void;
  onFatalError?: (error: Error) => void;
  onRoomChanged?: () => void;
}) {
  let closed = false;
  let profileSubscriptions: BuzzSubscription[] = [];
  const pendingRoomIds = new Set<string>();
  let refreshInFlight: Promise<void> | undefined;
  let fatalErrorReported = false;

  const reportError = (error: unknown) => {
    if (closed || params.signal?.aborted) {
      return;
    }
    params.onError?.(
      error instanceof Error ? error : new Error("Buzz directory refresh failed", { cause: error }),
    );
  };
  const reportFatalError = (error: Error) => {
    if (closed || params.signal?.aborted || fatalErrorReported) {
      return;
    }
    fatalErrorReported = true;
    params.onFatalError?.(error);
    params.relay.close();
  };

  const closeProfileSubscriptions = (reason: string, skip?: BuzzSubscription) => {
    const current = profileSubscriptions;
    profileSubscriptions = [];
    for (const subscription of current) {
      if (subscription !== skip && !subscription.closed) {
        subscription.close(reason);
      }
    }
  };

  const replaceProfilePublicKeys = (publicKeys: string[]) => {
    if (closed || params.signal?.aborted) {
      return;
    }
    // Profile labels are best-effort; new keys replace unfinished profile reads.
    closeProfileSubscriptions(PROFILE_SUBSCRIPTION_REPLACED_REASON);
    for (const authors of chunkItems(publicKeys, BUZZ_PROFILE_QUERY_CHUNK_SIZE)) {
      const subscription = openBuzzRelaySubscription(
        params.relay,
        [
          {
            kinds: [BUZZ_PROFILE_KIND],
            authors,
            limit: authors.length,
          },
        ],
        {
          onevent: (event) => {
            params.state.applyProfileEvent(event);
          },
          onclose: (reason) => {
            if (
              reason !== PROFILE_SUBSCRIPTION_REPLACED_REASON &&
              reason !== PROFILE_SUBSCRIPTION_FAILED_REASON &&
              reason !== DIRECTORY_SHUTDOWN_REASON &&
              reason !== "relay connection closed by us"
            ) {
              closeProfileSubscriptions(PROFILE_SUBSCRIPTION_FAILED_REASON, subscription);
              reportError(new Error(`Buzz profile subscription closed: ${reason}`));
            }
          },
        },
      );
      profileSubscriptions.push(subscription);
    }
  };

  const refreshRooms = (channelIds: string[]): Promise<void> => {
    if (closed || params.signal?.aborted) {
      return Promise.resolve();
    }
    for (const channelId of channelIds) {
      pendingRoomIds.add(channelId);
    }
    if (refreshInFlight) {
      return refreshInFlight;
    }
    refreshInFlight = (async () => {
      while (pendingRoomIds.size > 0) {
        if (closed || params.signal?.aborted) {
          pendingRoomIds.clear();
          return;
        }
        const nextRoomIds = [...pendingRoomIds];
        pendingRoomIds.clear();
        await queryBuzzDirectoryRooms({
          relay: params.relay,
          relayPublicKey: params.relayPublicKey,
          state: params.state,
          channelIds: nextRoomIds,
          onRoomChanged: params.onRoomChanged,
          onTimeout: reportFatalError,
          signal: params.signal,
        });
        const changedRoomId = nextRoomIds.find(
          (channelId) =>
            params.subscribedRoomIds?.has(channelId) === params.state.isRoomArchived(channelId),
        );
        if (changedRoomId) {
          reportFatalError(
            new Error(
              `Buzz room ${changedRoomId} archive status changed; rebuilding subscriptions`,
            ),
          );
          return;
        }
      }
    })().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  };

  return {
    replaceProfilePublicKeys,
    refreshRooms,
    close: () => {
      closed = true;
      closeProfileSubscriptions(DIRECTORY_SHUTDOWN_REASON);
      pendingRoomIds.clear();
    },
  };
}
