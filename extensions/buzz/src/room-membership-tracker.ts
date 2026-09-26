import type { Event, Relay } from "nostr-tools";
import { isNewerBuzzRevision } from "./event-order.js";
import { catchUpBuzzRoomHistory } from "./history-catchup.js";
import { isBuzzInboundMessageKind } from "./message-event.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  type BuzzReplayDispatchReservation,
} from "./replay-dispatch.js";
import type { BuzzRoomMembershipNotification } from "./room-membership-notification.js";
import { queryBuzzRoomMemberships } from "./room-membership-query.js";
import {
  BUZZ_ROOM_METADATA_EDIT_KIND,
  startBuzzRoomMembershipSubscription,
} from "./room-membership-subscription.js";
import {
  BUZZ_ROOM_MEMBERSHIP_KIND,
  parseBuzzRoomMembershipEvent,
  parseBuzzRoomMembershipChangeEvent,
  type BuzzRoomMembership,
} from "./room-membership.js";

const MEMBERSHIP_REFRESH_DELAYS_MS = [100, 500, 1_500, 3_000] as const;
const MEMBERSHIP_EVENT_CACHE_MAX_ENTRIES = 10_000;

async function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(
          error instanceof Error
            ? error
            : new Error("Buzz room membership refresh failed", { cause: error }),
        );
      }
    };
    const onAbort = () =>
      finish(signal?.reason ?? new Error("Buzz room membership refresh aborted"));
    const timer = setTimeout(() => finish(), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

export function createBuzzRoomMembershipTracker(params: {
  relay: Relay;
  relayPublicKey: string;
  channelIds: string[];
  isRoomArchived?: (channelId: string) => boolean;
  botPublicKey: string;
  since: number;
  messageSince: (channelId: string) => number;
  messageLimit: number;
  reserveDispatchCapacity: (slots: number) => Promise<BuzzReplayDispatchReservation | undefined>;
  onMessageEvent: (
    event: Event,
    isMember: (channelId: string, publicKey: string) => boolean,
    signal: AbortSignal,
    reservation?: BuzzReplayDispatchReservation,
  ) => void;
  onFatalError?: (error: Error) => void;
  onHistoryError?: (error: Error) => void;
  onRoomUnavailable?: (error: Error) => void;
  onMembershipsChanged?: (memberships: ReadonlyMap<string, BuzzRoomMembership>) => void;
  onRoomMetadataChanged?: (channelId: string) => void;
  signal?: AbortSignal;
}): {
  ready: Promise<void>;
  memberships: () => ReadonlyMap<string, BuzzRoomMembership>;
  catchUpHistory: () => Promise<void>;
  reconcileRooms: () => Promise<void>;
  handleNotification: (notification: BuzzRoomMembershipNotification) => boolean;
  close: () => Promise<void>;
} {
  type ExpectedMembership = "present" | "absent";
  type RoomGeneration = { controller: AbortController; signal: AbortSignal };
  type RefreshState = {
    room: RoomGeneration;
    generation: number;
    lastAttemptedGeneration: number;
    promise: Promise<void>;
  };
  type RestoringRoom = { historical: boolean; generation: number; until?: number };

  const roomGenerations = new Map<string, RoomGeneration>();
  const createRoomGeneration = (channelId: string): RoomGeneration => {
    const controller = new AbortController();
    const room = {
      controller,
      signal: params.signal
        ? AbortSignal.any([controller.signal, params.signal])
        : controller.signal,
    };
    roomGenerations.set(channelId, room);
    return room;
  };
  const isCurrentRoom = (channelId: string, room: RoomGeneration) =>
    roomGenerations.get(channelId) === room &&
    !room.signal.aborted &&
    !params.isRoomArchived?.(channelId);
  const initialActiveRoomIds = params.channelIds.filter(
    (channelId) => !params.isRoomArchived?.(channelId),
  );
  for (const channelId of initialActiveRoomIds) {
    createRoomGeneration(channelId);
  }
  const roomSubscriptions = new Map<
    string,
    ReturnType<typeof startBuzzRoomMembershipSubscription>
  >();
  const historyPages = new Map<string, { count: number; oldest: number }>();
  const seenEventIds = new Map<string, true>();
  const blockedRooms = new Set<string>();
  const deniedMembers = new Map<string, Set<string>>();
  const pendingMemberships = new Map<string, Map<string, ExpectedMembership>>();
  const refreshes = new Map<string, RefreshState>();
  const restoringRooms = new Map<string, RestoringRoom>();
  let membershipQueryTail = Promise.resolve();
  let memberships = new Map<string, BuzzRoomMembership>();
  let initialized = false;
  const effectiveMemberships = (): ReadonlyMap<string, BuzzRoomMembership> => {
    const effective = new Map<string, BuzzRoomMembership>();
    for (const [channelId, membership] of memberships) {
      if (
        blockedRooms.has(channelId) ||
        !roomGenerations.has(channelId) ||
        params.isRoomArchived?.(channelId)
      ) {
        continue;
      }
      const denied = deniedMembers.get(channelId);
      if (!denied || denied.size === 0) {
        effective.set(channelId, membership);
        continue;
      }
      effective.set(channelId, {
        ...membership,
        members: new Set([...membership.members].filter((publicKey) => !denied.has(publicKey))),
        roles: new Map([...membership.roles].filter(([publicKey]) => !denied.has(publicKey))),
      });
    }
    return effective;
  };
  const isMember = (channelId: string, publicKey: string) =>
    roomGenerations.has(channelId) &&
    !params.isRoomArchived?.(channelId) &&
    !blockedRooms.has(channelId) &&
    !deniedMembers.get(channelId)?.has(publicKey.trim().toLowerCase()) &&
    memberships.get(channelId)?.members.has(publicKey.trim().toLowerCase()) === true;

  const markSystemEventSeen = (eventId: string): boolean => {
    if (seenEventIds.has(eventId)) {
      return false;
    }
    seenEventIds.set(eventId, true);
    if (seenEventIds.size > MEMBERSHIP_EVENT_CACHE_MAX_ENTRIES) {
      const oldestEventId = seenEventIds.keys().next().value;
      if (oldestEventId) {
        seenEventIds.delete(oldestEventId);
      }
    }
    return true;
  };
  const reportSystemEventError = (error: unknown) => {
    if (params.signal?.aborted) {
      return;
    }
    params.onFatalError?.(error instanceof Error ? error : new Error(String(error)));
    params.relay.close();
  };
  const replaceMembership = (membership: BuzzRoomMembership) => {
    if (
      membership.roles.get(params.botPublicKey) !== "bot" ||
      !membership.members.has(params.botPublicKey)
    ) {
      blockedRooms.add(membership.roomId);
      throw new Error(`Buzz bot no longer has the Bot role in room ${membership.roomId}`);
    }
    memberships.set(membership.roomId, membership);
    params.onMembershipsChanged?.(effectiveMemberships());
  };
  const queryMembership = (
    channelId: string,
    room: RoomGeneration,
  ): Promise<BuzzRoomMembership | undefined> => {
    const query = membershipQueryTail.then(async () => {
      room.signal.throwIfAborted();
      return (
        await queryBuzzRoomMemberships({
          relay: params.relay,
          relayPublicKey: params.relayPublicKey,
          channelIds: [channelId],
          // Keep the shared relay query serialized until EOSE, even if this room retires.
          signal: params.signal,
        })
      ).get(channelId);
    });
    membershipQueryTail = query.then(
      () => undefined,
      () => undefined,
    );
    return query;
  };

  const refreshMembership = async (channelId: string, state: RefreshState): Promise<void> => {
    for (const delayMs of MEMBERSHIP_REFRESH_DELAYS_MS) {
      const generation = state.generation;
      state.lastAttemptedGeneration = generation;
      await sleepWithSignal(delayMs, state.room.signal);
      if (!isCurrentRoom(channelId, state.room)) {
        return;
      }
      if (state.generation !== generation) {
        continue;
      }
      let refreshed: BuzzRoomMembership | undefined;
      try {
        refreshed = await queryMembership(channelId, state.room);
        state.room.signal.throwIfAborted();
      } catch (error) {
        if (state.room.signal.aborted) {
          throw error;
        }
        continue;
      }
      if (!isCurrentRoom(channelId, state.room)) {
        return;
      }
      if (state.generation !== generation || !refreshed) {
        continue;
      }
      // A live roster may have advanced while this query was in flight.
      const current = memberships.get(channelId);
      if (current && isNewerBuzzRevision(current, refreshed)) {
        refreshed = current;
      }
      const pending = pendingMemberships.get(channelId);
      const pendingMatches =
        !pending ||
        [...pending].every(
          ([publicKey, expected]) => refreshed.members.has(publicKey) === (expected === "present"),
        );
      if (!pendingMatches) {
        continue;
      }
      pendingMemberships.delete(channelId);
      deniedMembers.delete(channelId);
      blockedRooms.delete(channelId);
      replaceMembership(refreshed);
      return;
    }
    if (state.generation !== state.lastAttemptedGeneration) {
      return;
    }
    blockedRooms.add(channelId);
    throw new Error(`Could not refresh Buzz room membership for ${channelId}`);
  };

  const refreshMembershipOnce = (channelId: string): Promise<void> => {
    const room = roomGenerations.get(channelId);
    if (!room || !isCurrentRoom(channelId, room)) {
      return Promise.resolve();
    }
    const current = refreshes.get(channelId);
    if (current) {
      current.generation += 1;
      return current.promise;
    }
    const state = {
      room,
      generation: 1,
      lastAttemptedGeneration: 0,
      promise: Promise.resolve(),
    } satisfies RefreshState;
    state.promise = refreshMembership(channelId, state)
      .catch((error: unknown) => {
        if (isCurrentRoom(channelId, room)) {
          throw error;
        }
      })
      .finally(() => {
        if (refreshes.get(channelId) === state) {
          refreshes.delete(channelId);
        }
        if (
          state.generation !== state.lastAttemptedGeneration &&
          pendingMemberships.has(channelId) &&
          isCurrentRoom(channelId, room)
        ) {
          void refreshMembershipOnce(channelId).catch(reportSystemEventError);
        }
      });
    refreshes.set(channelId, state);
    return state.promise;
  };

  const handleSystemEvent = (event: Event): Promise<void> | undefined => {
    if (!markSystemEventSeen(event.id)) {
      return undefined;
    }
    const channelId = event.tags
      .find((tag) => tag[0] === "h")?.[1]
      ?.trim()
      .toLowerCase();
    if (!channelId) {
      return undefined;
    }
    if (event.kind === BUZZ_ROOM_METADATA_EDIT_KIND) {
      params.onRoomMetadataChanged?.(channelId);
      return undefined;
    }
    const membership = memberships.get(channelId);
    if (!membership) {
      return undefined;
    }
    const change = parseBuzzRoomMembershipChangeEvent(event, membership);
    if (!change) {
      return undefined;
    }
    const restoring = restoringRooms.get(channelId);
    if (restoring?.historical) {
      // The post-EOSE snapshot reconciles history without treating reverse-order changes as current.
      return undefined;
    }
    if (restoring) {
      restoring.generation += 1;
    }
    // System events invalidate membership; the relay-signed roster decides the
    // final state. Removals deny immediately, while joins wait for confirmation.
    const expected = change.type === "member_joined" ? "present" : "absent";
    const pending = pendingMemberships.get(channelId) ?? new Map<string, ExpectedMembership>();
    pending.set(change.targetPublicKey, expected);
    pendingMemberships.set(channelId, pending);
    if (expected === "absent") {
      const denied = deniedMembers.get(channelId) ?? new Set<string>();
      denied.add(change.targetPublicKey);
      deniedMembers.set(channelId, denied);
    }
    if (change.targetPublicKey === params.botPublicKey) {
      blockedRooms.add(channelId);
    }
    params.onMembershipsChanged?.(effectiveMemberships());
    return refreshMembershipOnce(channelId);
  };
  const handleRoomEvent = (
    event: Event,
    room: RoomGeneration,
    reservation?: BuzzReplayDispatchReservation,
  ) => {
    if (room.signal.aborted) {
      return;
    }
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    const restoring = channelId ? restoringRooms.get(channelId) : undefined;
    if (restoring && isBuzzInboundMessageKind(event.kind)) {
      // Re-query this bounded range after roster reconciliation; do not commit it to replay yet.
      restoring.until = Math.max(restoring.until ?? event.created_at, event.created_at);
      return;
    }
    if (event.kind === BUZZ_ROOM_MEMBERSHIP_KIND) {
      const membership = parseBuzzRoomMembershipEvent(event, params.relayPublicKey);
      if (
        membership &&
        memberships.has(membership.roomId) &&
        isNewerBuzzRevision(membership, memberships.get(membership.roomId))
      ) {
        try {
          replaceMembership(membership);
        } catch (error) {
          reportSystemEventError(error);
        }
      }
      return;
    }
    if (isBuzzInboundMessageKind(event.kind)) {
      params.onMessageEvent(
        event,
        (roomId, publicKey) => isCurrentRoom(roomId, room) && isMember(roomId, publicKey),
        room.signal,
        reservation,
      );
      return;
    }
    void handleSystemEvent(event)?.catch(reportSystemEventError);
  };

  const skippedRooms = new Set(
    params.channelIds.filter((channelId) => !roomGenerations.has(channelId)),
  );
  const initialRoomIds: string[] = [];

  const subscribeRoom = (channelId: string, room: RoomGeneration): Promise<void> => {
    room.signal.throwIfAborted();
    historyPages.delete(channelId);
    const subscription = startBuzzRoomMembershipSubscription({
      relay: params.relay,
      relayPublicKey: params.relayPublicKey,
      channelId,
      since: params.since,
      messageSince: params.messageSince(channelId),
      messageLimit: params.messageLimit,
      signal: params.signal,
      isCurrent: () => isCurrentRoom(channelId, room),
      onEvent: (event, historical) => {
        if (historical && isBuzzInboundMessageKind(event.kind)) {
          const page = historyPages.get(channelId);
          if (page) {
            page.count += 1;
            page.oldest = Math.min(page.oldest, event.created_at);
          } else {
            historyPages.set(channelId, { count: 1, oldest: event.created_at });
          }
        }
        handleRoomEvent(event, room);
      },
      onReady: () => {
        const restoring = restoringRooms.get(channelId);
        if (restoring) {
          restoring.historical = false;
        }
      },
      onError: reportSystemEventError,
    });
    roomSubscriptions.set(channelId, subscription);
    return subscription.ready;
  };

  let historyTail = Promise.resolve();
  const catchUpHistory = (channelIds: string[], recoveryUntil?: number): Promise<void> => {
    const rooms = channelIds.map((channelId) => ({
      channelId,
      room: roomGenerations.get(channelId),
    }));
    const task = historyTail
      .then(async () => {
        for (const { channelId, room } of rooms) {
          if (!room || !isCurrentRoom(channelId, room)) {
            continue;
          }
          const page = historyPages.get(channelId);
          const until = recoveryUntil ?? page?.oldest;
          if (params.signal?.aborted) {
            return;
          }
          if (
            until === undefined ||
            (recoveryUntil === undefined && page && page.count < params.messageLimit)
          ) {
            continue;
          }
          let outcome: Awaited<ReturnType<typeof catchUpBuzzRoomHistory>>;
          try {
            outcome = await catchUpBuzzRoomHistory({
              relay: params.relay,
              channelId,
              since: params.messageSince(channelId),
              until,
              limit: params.messageLimit,
              reserveCapacity: async (slots) => {
                if (!isCurrentRoom(channelId, room)) {
                  return undefined;
                }
                const reservation = await params.reserveDispatchCapacity(slots);
                if (!isCurrentRoom(channelId, room)) {
                  reservation?.release();
                  return undefined;
                }
                return reservation;
              },
              onEvent: (event, reservation) => handleRoomEvent(event, room, reservation),
              signal: params.signal,
            });
          } catch (error) {
            if (!isCurrentRoom(channelId, room)) {
              continue;
            }
            throw error;
          }
          if (outcome === "timestamp-over-limit") {
            params.onHistoryError?.(
              new Error(
                `Buzz room ${channelId} kept more than ${BUZZ_REPLAY_DISPATCH_MAX_PENDING} additional messages at one timestamp; older history was not recovered`,
              ),
            );
          }
        }
      })
      .catch(reportSystemEventError);
    historyTail = task;
    return task;
  };

  type Restoration = { room: RoomGeneration; generation: number; promise: Promise<void> };
  const restorations = new Map<string, Restoration>();
  const restoreRoom = async (channelId: string, state: Restoration): Promise<void> => {
    // Archive is not a membership grant: reconcile removals observed before it first.
    if (pendingMemberships.has(channelId)) {
      await refreshMembershipOnce(channelId);
    }
    while (isCurrentRoom(channelId, state.room)) {
      const generation = state.generation;
      let refreshed = await queryMembership(channelId, state.room);
      if (!isCurrentRoom(channelId, state.room)) {
        return;
      }
      if (generation !== state.generation) {
        continue;
      }
      const current = memberships.get(channelId);
      if (current && refreshed && isNewerBuzzRevision(current, refreshed)) {
        refreshed = current;
      }
      if (!refreshed) {
        return;
      }
      if (refreshed.roles.get(params.botPublicKey) !== "bot") {
        memberships.set(channelId, refreshed);
        params.onMembershipsChanged?.(effectiveMemberships());
        return;
      }
      replaceMembership(refreshed);
      if (!isCurrentRoom(channelId, state.room)) {
        return;
      }
      // Once subscribed, even a pre-EOSE downgrade must revoke the account generation.
      skippedRooms.delete(channelId);
      const restoring: RestoringRoom = { historical: true, generation: 0 };
      restoringRooms.set(channelId, restoring);
      await subscribeRoom(channelId, state.room);
      while (isCurrentRoom(channelId, state.room)) {
        // Live invalidations keep their existing bounded refresh and immediate sender denial.
        const refresh = refreshes.get(channelId);
        if (refresh) {
          await refresh.promise;
        }
        if (!isCurrentRoom(channelId, state.room)) {
          return;
        }
        const reconciliationGeneration = restoring.generation;
        let confirmed = await queryMembership(channelId, state.room);
        if (!isCurrentRoom(channelId, state.room)) {
          return;
        }
        if (reconciliationGeneration !== restoring.generation || refreshes.has(channelId)) {
          continue;
        }
        const latest = memberships.get(channelId);
        if (latest && confirmed && isNewerBuzzRevision(latest, confirmed)) {
          confirmed = latest;
        }
        if (!confirmed) {
          throw new Error(`Buzz room membership missing after restoration for ${channelId}`);
        }
        replaceMembership(confirmed);
        if (!isCurrentRoom(channelId, state.room)) {
          return;
        }
        restoringRooms.delete(channelId);
        await catchUpHistory([channelId], restoring.until);
        return;
      }
      return;
    }
  };

  const startRestoration = (channelId: string): Promise<void> => {
    if (!initialized) {
      return ready.then(() => startRestoration(channelId));
    }
    if (
      params.signal?.aborted ||
      params.isRoomArchived?.(channelId) ||
      !skippedRooms.has(channelId)
    ) {
      return Promise.resolve();
    }
    const room = roomGenerations.get(channelId) ?? createRoomGeneration(channelId);
    const existing = restorations.get(channelId);
    if (existing) {
      if (existing.room === room) {
        existing.generation += 1;
        return existing.promise;
      }
      return existing.promise.then(() => startRestoration(channelId));
    }
    const state: Restoration = { room, generation: 1, promise: Promise.resolve() };
    restorations.set(channelId, state);
    state.promise = restoreRoom(channelId, state)
      .catch((error: unknown) => {
        if (isCurrentRoom(channelId, room)) {
          reportSystemEventError(error);
        }
      })
      .finally(() => {
        if (restorations.get(channelId) === state) {
          restorations.delete(channelId);
        }
      });
    return state.promise;
  };

  const initialize = async () => {
    memberships = await queryBuzzRoomMemberships({
      ...params,
      channelIds: initialActiveRoomIds,
    });
    params.signal?.throwIfAborted();
    for (const channelId of initialActiveRoomIds) {
      const room = roomGenerations.get(channelId);
      if (!room || !isCurrentRoom(channelId, room)) {
        skippedRooms.add(channelId);
        continue;
      }
      if (memberships.get(channelId)?.roles.get(params.botPublicKey) !== "bot") {
        skippedRooms.add(channelId);
        params.onRoomUnavailable?.(
          new Error(`Buzz bot does not have the Bot role in configured room ${channelId}`),
        );
      } else {
        initialRoomIds.push(channelId);
      }
    }
    if (
      initialActiveRoomIds.some((channelId) => !params.isRoomArchived?.(channelId)) &&
      initialRoomIds.length === 0 &&
      !params.channelIds.some(
        (channelId) => !roomGenerations.has(channelId) && !params.isRoomArchived?.(channelId),
      )
    ) {
      throw new Error(
        `Buzz bot does not have the Bot role in any configured room: ${params.channelIds.join(", ")}`,
      );
    }

    // Initial readiness has a fixed denominator; later grants own their own EOSE waiter.
    const initialSubscriptions: Promise<void>[] = [];
    try {
      for (const channelId of initialRoomIds) {
        const room = roomGenerations.get(channelId);
        if (room && isCurrentRoom(channelId, room)) {
          initialSubscriptions.push(subscribeRoom(channelId, room));
        }
      }
      await Promise.all(initialSubscriptions);
    } catch (error) {
      params.relay.close();
      await Promise.allSettled(initialSubscriptions);
      throw error;
    }
    initialized = true;
  };
  const ready = initialize();

  return {
    ready,
    memberships: effectiveMemberships,
    catchUpHistory: () => catchUpHistory(initialRoomIds),
    reconcileRooms: async () => {
      const restore: string[] = [];
      for (const channelId of params.channelIds) {
        if (!params.isRoomArchived?.(channelId)) {
          if (initialized && !roomGenerations.has(channelId)) {
            restore.push(channelId);
          }
          continue;
        }
        const room = roomGenerations.get(channelId);
        if (!room) {
          continue;
        }
        roomGenerations.delete(channelId);
        room.controller.abort(new Error(`Buzz room ${channelId} archived`));
        skippedRooms.add(channelId);
        refreshes.delete(channelId);
        restoringRooms.delete(channelId);
        historyPages.delete(channelId);
        const subscription = roomSubscriptions.get(channelId);
        if (subscription) {
          roomSubscriptions.delete(channelId);
          subscription.retire();
        }
      }
      params.onMembershipsChanged?.(effectiveMemberships());
      await Promise.all(restore.map(startRestoration));
    },
    handleNotification: (notification) => {
      if (params.signal?.aborted || seenEventIds.has(notification.eventId)) {
        return true;
      }
      if (params.isRoomArchived?.(notification.roomId)) {
        markSystemEventSeen(notification.eventId);
        return true;
      }
      if (!skippedRooms.has(notification.roomId)) {
        return false;
      }
      markSystemEventSeen(notification.eventId);
      void startRestoration(notification.roomId).catch(reportSystemEventError);
      return true;
    },
    close: async () => {
      await Promise.allSettled([
        ready,
        ...[...restorations.values()].map((state) => state.promise),
        ...[...refreshes.values()].map((state) => state.promise),
        historyTail,
      ]);
    },
  };
}
