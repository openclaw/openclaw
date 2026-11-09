import type { Event } from "nostr-tools";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "./relay-auth.js";
import { openBuzzRelaySubscription } from "./relay-subscription.js";
import { discoverBuzzRoomsOnRelay, type BuzzDiscoveredRoom } from "./room-discovery.js";
import { BUZZ_MEMBER_ADDED_NOTIFICATION_KIND } from "./room-membership-notification.js";
import { BUZZ_CHANNEL_ID_PATTERN } from "./target.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 90_000;
const DISCOVERY_POLL_INTERVAL_MS = 2_000;

function hasValidRoomTag(event: Event): boolean {
  return event.tags.some(
    (tag) => tag[0] === "h" && Boolean(tag[1]?.toLowerCase().match(BUZZ_CHANNEL_ID_PATTERN)),
  );
}

export async function waitForBuzzRoomAccess(params: {
  relayUrl: string;
  privateKey: string;
  authTag?: string;
}): Promise<BuzzDiscoveredRoom[]> {
  const secretKey = decodeBuzzPrivateKey(params.privateKey);
  const publicKey = resolveBuzzPublicKey(params.privateKey);
  const signal = AbortSignal.timeout(DEFAULT_WAIT_TIMEOUT_MS);
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: params.relayUrl,
    secretKey,
    authTag: parseBuzzAuthTag(params.authTag ?? ""),
    signal,
  });

  try {
    return await new Promise<BuzzDiscoveredRoom[]>((resolve, reject) => {
      let settled = false;
      let checking = false;

      const finish = (error?: unknown, rooms?: BuzzDiscoveredRoom[]) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        clearInterval(pollTimer);
        if (error !== undefined) {
          reject(
            error instanceof Error
              ? error
              : new Error("Buzz room access wait failed", { cause: error }),
          );
        } else {
          resolve(rooms ?? []);
        }
      };
      const onAbort = () => finish();
      const checkRooms = async () => {
        if (checking) {
          return;
        }
        checking = true;
        try {
          signal.throwIfAborted();
          const rooms = await discoverBuzzRoomsOnRelay({
            relay,
            relayPublicKey,
            publicKey,
            timeoutMs: 10_000,
            signal,
          });
          if (rooms.length > 0) {
            finish(undefined, rooms);
          }
        } catch (error) {
          if (signal.aborted) {
            finish(error);
          }
          // Room publication may lag its notification; the next poll retries the snapshot.
        } finally {
          checking = false;
        }
      };

      signal.addEventListener("abort", onAbort, { once: true });
      openBuzzRelaySubscription(
        relay,
        [
          {
            kinds: [BUZZ_MEMBER_ADDED_NOTIFICATION_KIND],
            "#p": [publicKey],
            since: Math.floor(Date.now() / 1000) - 30,
          },
        ],
        {
          onevent: (event) => {
            if (
              event.kind !== BUZZ_MEMBER_ADDED_NOTIFICATION_KIND ||
              !event.tags.some((tag) => tag[0] === "p" && tag[1] === publicKey) ||
              !hasValidRoomTag(event)
            ) {
              return;
            }
            void checkRooms();
          },
          oneose: () => {
            // Covers the race where room access was granted between the initial
            // discovery query and this live notification subscription.
            void checkRooms();
          },
          onclose: (reason) => {
            if (reason !== "room access found") {
              finish(new Error(`Buzz room access subscription closed: ${reason}`));
            }
          },
        },
      );
      const pollTimer = setInterval(() => {
        void checkRooms();
      }, DISCOVERY_POLL_INTERVAL_MS);
      pollTimer.unref?.();
    });
  } finally {
    relay.close();
  }
}
