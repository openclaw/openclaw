import type { Event, Relay } from "nostr-tools";
import { BUZZ_INBOUND_MESSAGE_KINDS } from "./message-event.js";
import { queryBuzzRelaySnapshot } from "./relay-subscription.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  type BuzzReplayDispatchReservation,
} from "./replay-dispatch.js";

const HISTORY_PAGE_COMPLETE_REASON = "buzz room history page loaded";

type BuzzRoomHistoryCatchUp = "complete" | "aborted" | "timestamp-over-limit";

export async function catchUpBuzzRoomHistory(params: {
  relay: Relay;
  channelId: string;
  since: number;
  until: number;
  limit: number;
  reserveCapacity: (slots: number) => Promise<BuzzReplayDispatchReservation | undefined>;
  onEvent: (event: Event, reservation: BuzzReplayDispatchReservation) => void;
  signal?: AbortSignal;
}): Promise<BuzzRoomHistoryCatchUp> {
  const { relay, channelId, reserveCapacity, onEvent, signal } = params;
  async function queryBuzzRoomHistoryPage(range: {
    since: number;
    until: number;
    requestLimit?: number;
    maxEvents: number;
    skipEventIds?: ReadonlySet<string>;
  }) {
    const events: Event[] = [];
    let overLimit = false;
    return await queryBuzzRelaySnapshot({
      relay,
      filters: [
        {
          kinds: [...BUZZ_INBOUND_MESSAGE_KINDS],
          "#h": [channelId],
          since: range.since,
          until: range.until,
          ...(range.requestLimit === undefined ? {} : { limit: range.requestLimit }),
        },
      ],
      signal,
      timeoutMessage: `Timed out loading Buzz room history for ${channelId}`,
      abortMessage: "Buzz room history query aborted",
      failureMessage: "Buzz room history query failed",
      closeReason: HISTORY_PAGE_COMPLETE_REASON,
      closeMessage: (reason) => `Buzz room history query closed for ${channelId}: ${reason}`,
      onEvent: (event) => {
        if (range.skipEventIds?.has(event.id)) {
          return;
        }
        if (events.length < range.maxEvents) {
          events.push(event);
        } else {
          overLimit = true;
        }
      },
      result: () => ({ events, overLimit }),
    });
  }

  type BuzzRoomHistoryPage = Awaited<ReturnType<typeof queryBuzzRoomHistoryPage>>;

  async function drainBuzzRoomHistoryRange(range: {
    since: number;
    until: number;
    skipEventIds: ReadonlySet<string>;
  }): Promise<BuzzRoomHistoryCatchUp> {
    if (signal?.aborted) {
      return "aborted";
    }
    const page = await queryBuzzRoomHistoryPage({
      since: range.since,
      until: range.until,
      maxEvents: BUZZ_REPLAY_DISPATCH_MAX_PENDING,
      skipEventIds: range.skipEventIds,
    });
    if (!page.overLimit || range.since === range.until) {
      if (page.events.length === 0) {
        return "complete";
      }
      const reservation = await reserveCapacity(page.events.length);
      if (!reservation) {
        return "aborted";
      }
      try {
        for (const event of page.events) {
          onEvent(event, reservation);
        }
      } finally {
        reservation.release();
      }
      return page.overLimit ? "timestamp-over-limit" : "complete";
    }

    // NIP-01 has only a second-resolution time cursor. Split an overfull range
    // until every query fits; only a single overfull second is irreducible.
    const midpoint = Math.floor((range.since + range.until) / 2);
    const newer = await drainBuzzRoomHistoryRange({
      ...range,
      since: midpoint + 1,
    });
    if (newer !== "complete") {
      return newer;
    }
    return await drainBuzzRoomHistoryRange({
      ...range,
      until: midpoint,
    });
  }

  let until = params.until;
  while (!params.signal?.aborted) {
    const reservation = await reserveCapacity(params.limit);
    if (!reservation) {
      return "aborted";
    }
    let page: BuzzRoomHistoryPage;
    try {
      if (signal?.aborted) {
        return "aborted";
      }
      page = await queryBuzzRoomHistoryPage({
        since: params.since,
        until,
        requestLimit: params.limit,
        maxEvents: params.limit,
      });
      if (page.events.length === 0) {
        return "complete";
      }
      for (const event of page.events) {
        onEvent(event, reservation);
      }
    } finally {
      reservation.release();
    }
    let oldest = until;
    for (const event of page.events) {
      oldest = Math.min(oldest, event.created_at);
    }
    const skipEventIds = new Set(page.events.map((event) => event.id));
    if (page.overLimit) {
      return await drainBuzzRoomHistoryRange({
        since: params.since,
        until,
        skipEventIds,
      });
    }
    if (page.events.length < params.limit) {
      return "complete";
    }
    if (oldest >= until) {
      const outcome = await drainBuzzRoomHistoryRange({
        since: until,
        until,
        skipEventIds,
      });
      if (outcome !== "complete") {
        return outcome;
      }
      if (until <= params.since) {
        return "complete";
      }
      until -= 1;
      continue;
    }
    until = oldest;
  }
  return "aborted";
}
