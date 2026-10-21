import type { Event, Filter } from "nostr-tools";
import { vi } from "vitest";

type Handlers = {
  onevent: (event: Event) => void;
  oneose?: () => void;
  onclose: (reason: string) => void;
};

export const relayMocks = {
  connect: vi.fn<() => Promise<void>>(),
  auth: vi.fn<() => Promise<string>>(),
  publish: vi.fn<(event: Event) => Promise<string>>(),
  send: vi.fn<(message: string) => Promise<void>>(),
  close: vi.fn(),
  connected: true,
  stallProfileQueryEose: false,
  stallThreadRootQueryEose: false,
  stallRoomEoseChannelId: undefined as string | undefined,
  membershipEvents: [] as Event[],
  roomMetadataEvents: [] as Event[],
  profileEvents: [] as Event[],
  roomHistoryEvents: [] as Event[],
  threadRootEvents: [] as Event[],
  beforeRoomHistoryEvent: undefined as ((event: Event) => void) | undefined,
  subscriptions: [] as Array<{
    filter: Filter;
    filters: Filter[];
    handlers: Handlers;
    close: ReturnType<typeof vi.fn>;
  }>,
};

export const mockBuzzRelay = () => ({
  Relay: class {
    onauth?: (template: unknown) => Promise<unknown>;
    idleSince: number | undefined;
    ongoingOperations = 0;
    get connected() {
      return relayMocks.connected;
    }
    connect = relayMocks.connect;
    auth = relayMocks.auth;
    publish = relayMocks.publish;
    send = relayMocks.send;
    close = relayMocks.close;
    scheduleIdleClose = vi.fn();

    prepareSubscription(filters: Filter[], handlers: Handlers) {
      const state = relayMocks;
      const filter = filters[0] ?? {};
      const close = vi.fn();
      state.subscriptions.push({ filter, filters, handlers, close });
      let events: Event[] | undefined;
      let canEnd = () => true;
      if (filter.ids) {
        events = state.threadRootEvents;
        canEnd = () => !state.stallThreadRootQueryEose;
      } else if (filter.kinds?.includes(39002)) {
        events = state.membershipEvents;
      } else if (filter.kinds?.includes(40099) || filter.kinds?.includes(9002)) {
        const roomId = filter["#h"]?.[0];
        for (const entry of filters) {
          for (const event of state.roomHistoryEvents) {
            const eventRoomId = event.tags.find((tag) => tag[0] === "h")?.[1];
            if (entry.kinds?.includes(event.kind) && entry["#h"]?.includes(eventRoomId ?? "")) {
              state.beforeRoomHistoryEvent?.(event);
              handlers.onevent(event);
            }
          }
        }
        events = [];
        canEnd = () => roomId !== state.stallRoomEoseChannelId;
      } else if (filter.kinds?.includes(39000)) {
        events = state.roomMetadataEvents.filter((event) => {
          const roomId = event.tags.find((tag) => tag[0] === "d")?.[1];
          return !filter["#d"] || Boolean(roomId && filter["#d"]?.includes(roomId));
        });
      } else if (filter.kinds?.includes(0)) {
        events = state.profileEvents.filter(
          (event) => !filter.authors || filter.authors.includes(event.pubkey),
        );
        canEnd = () =>
          !filters.some((entry) => entry.kinds?.includes(10_100)) || !state.stallProfileQueryEose;
      }
      for (const event of events ?? []) {
        handlers.onevent(event);
      }
      if (events && canEnd()) {
        queueMicrotask(() => handlers.oneose?.());
      }
      const id = `sub:${state.subscriptions.length}`;
      return { id, close, closed: false };
    }
  },
});
