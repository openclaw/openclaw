import type { Relay } from "nostr-tools";
import { chunkItems } from "openclaw/plugin-sdk/text-chunking";
import { isNewerBuzzRevision } from "./event-order.js";
import { queryBuzzRelaySnapshot } from "./relay-subscription.js";
import {
  BUZZ_ROOM_MEMBERSHIP_KIND,
  parseBuzzRoomMembershipEvent,
  type BuzzRoomMembership,
} from "./room-membership.js";

const RELAY_QUERY_EVENT_LIMIT = 1_000;
const MEMBERSHIP_QUERY_COMPLETE_REASON = "membership snapshot loaded";

export async function queryBuzzRoomMemberships(params: {
  relay: Relay;
  relayPublicKey: string;
  channelIds: string[];
  signal?: AbortSignal;
}): Promise<Map<string, BuzzRoomMembership>> {
  const memberships = new Map<string, BuzzRoomMembership>();
  for (const channelIds of chunkItems(params.channelIds, RELAY_QUERY_EVENT_LIMIT)) {
    const configuredRooms = new Set(channelIds);
    await queryBuzzRelaySnapshot({
      relay: params.relay,
      filters: [
        {
          kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
          authors: [params.relayPublicKey],
          "#d": channelIds,
          limit: channelIds.length,
        },
      ],
      signal: params.signal,
      timeoutMessage: "Timed out loading Buzz room membership snapshot",
      abortMessage: "Buzz room membership query aborted",
      failureMessage: "Buzz room membership query failed",
      closeReason: MEMBERSHIP_QUERY_COMPLETE_REASON,
      closeMessage: (reason) => `Buzz room membership query closed: ${reason}`,
      onEvent: (event) => {
        const membership = parseBuzzRoomMembershipEvent(event, params.relayPublicKey);
        if (
          membership &&
          configuredRooms.has(membership.roomId) &&
          isNewerBuzzRevision(membership, memberships.get(membership.roomId))
        ) {
          memberships.set(membership.roomId, membership);
        }
      },
      result: () => {},
      checkAbortAfterSubscribe: true,
    });
  }
  return memberships;
}
