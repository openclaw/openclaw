import type { Event, Filter, Relay } from "nostr-tools";
import { BUZZ_INBOUND_MESSAGE_KINDS } from "./message-event.js";
import { openBuzzRelaySubscription } from "./relay-subscription.js";
import { BUZZ_ROOM_MEMBERSHIP_KIND, BUZZ_ROOM_SYSTEM_KIND } from "./room-membership.js";

export const BUZZ_ROOM_METADATA_EDIT_KIND = 9_002;
const MEMBERSHIP_READY_TIMEOUT_MS = 10_000;
const ROOM_ARCHIVED_CLOSE_REASON = "room archived";

export function startBuzzRoomMembershipSubscription(params: {
  relay: Relay;
  relayPublicKey: string;
  channelId: string;
  since: number;
  messageSince: number;
  messageLimit: number;
  signal?: AbortSignal;
  isCurrent: () => boolean;
  onEvent: (event: Event, historical: boolean) => void;
  onReady: () => void;
  onError: (error: Error) => void;
}): { ready: Promise<void>; retire: () => void } {
  let subscription: ReturnType<Relay["prepareSubscription"]> | undefined;
  let receivedEose = false;
  let retired = false;
  const closeRetired = () => {
    // REQ may still be registering remotely; send CLOSE only after real EOSE.
    if (retired && receivedEose && subscription && !subscription.closed) {
      subscription.close(ROOM_ARCHIVED_CLOSE_REASON);
    }
  };
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(
          error instanceof Error
            ? error
            : new Error("Buzz room membership loading failed", { cause: error }),
        );
      }
    };
    const onAbort = () =>
      finish(params.signal?.reason ?? new Error("Buzz membership loading aborted"));
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out loading Buzz room membership changes for ${params.channelId}`));
      params.relay.close();
    }, MEMBERSHIP_READY_TIMEOUT_MS);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    // System changes precede message history so revoked senders cannot enter the queue.
    const filters: Filter[] = [
      {
        kinds: [BUZZ_ROOM_SYSTEM_KIND, BUZZ_ROOM_METADATA_EDIT_KIND],
        "#h": [params.channelId],
        since: params.since,
      },
      {
        kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
        authors: [params.relayPublicKey],
        "#d": [params.channelId],
        limit: 1,
      },
      {
        kinds: [...BUZZ_INBOUND_MESSAGE_KINDS],
        "#h": [params.channelId],
        since: params.messageSince,
        limit: params.messageLimit,
      },
    ];
    try {
      subscription = openBuzzRelaySubscription(
        params.relay,
        filters,
        {
          onevent: (event) => {
            if (!retired && params.isCurrent()) {
              params.onEvent(event, !receivedEose);
            }
          },
          oneose: () => {
            receivedEose = true;
            closeRetired();
            if (!retired && params.isCurrent()) {
              params.onReady();
            }
            finish();
          },
          onclose: (reason) => {
            if (retired || !params.isCurrent()) {
              finish();
              return;
            }
            const error = new Error(
              `Buzz membership subscription closed for ${params.channelId}: ${reason}`,
            );
            if (!receivedEose) {
              finish(error);
            } else if (
              reason !== "shutdown" &&
              reason !== "relay connection closed by us" &&
              !params.signal?.aborted
            ) {
              params.onError(error);
            }
          },
        },
        // Buzz routes on #h while signed rosters retain #d for client validation.
        filters.map((filter) => Object.assign({}, filter, { "#h": [params.channelId] })),
      );
      closeRetired();
    } catch (error) {
      finish(error);
    }
  });
  return {
    ready,
    retire: () => {
      retired = true;
      closeRetired();
    },
  };
}
