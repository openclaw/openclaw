import { matchFilter, Relay, type Event, type Filter } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const history = vi.hoisted(() => ({
  storedEvents: [] as Event[],
  historyRequests: [] as Filter[],
  stallHistoryPages: false,
  closeHistoryPagesReason: undefined as string | undefined,
  overReturnHistoryPages: false,
}));

function selectRelayEvents(filter: Filter): Event[] {
  const matched = history.storedEvents
    .filter((event) => matchFilter(filter, event))
    .toSorted((left, right) => right.created_at - left.created_at);
  return filter.limit === undefined ||
    (history.overReturnHistoryPages && filter.until !== undefined)
    ? matched
    : matched.slice(0, filter.limit);
}

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return {
    ...(await importOriginal<typeof import("nostr-tools")>()),
    ...mockBuzzRelay((filters, handlers) => {
      let isHistoryPage = false;
      for (const filter of filters) {
        if (filter.kinds?.includes(9)) {
          history.historyRequests.push(filter);
          isHistoryPage ||= filter.until !== undefined;
        }
        for (const event of selectRelayEvents(filter)) {
          handlers.onevent(event);
        }
        if (history.closeHistoryPagesReason && isHistoryPage) {
          queueMicrotask(() => {
            handlers.onclose(history.closeHistoryPagesReason ?? "relay closed");
          });
          break;
        }
      }
      if ((!history.stallHistoryPages && !history.closeHistoryPagesReason) || !isHistoryPage) {
        queueMicrotask(() => handlers.oneose?.());
      }
      return {
        id: `sub:${history.historyRequests.length}`,
        close: vi.fn(),
        closed: false,
      };
    }),
  };
});

import { useBuzzBusLifecycleFixture } from "./buzz-bus.lifecycle.test-harness.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  createBuzzReplayDispatchQueue,
} from "./replay-dispatch.js";
import { createBuzzRoomMembershipTracker } from "./room-membership-tracker.js";

const fixture = useBuzzBusLifecycleFixture();
const { CHANNEL_ID, startTestBus, senderMessage } = fixture;
const HISTORY_LIMIT = 100;
const BASE_TIMESTAMP = 1_700_000_000;

function seedOfflineBacklog(count: number, createdAt: (index: number) => number): void {
  history.storedEvents.push(
    ...Array.from({ length: count }, (_, index) =>
      senderMessage(`offline-message-${index}`, { created_at: createdAt(index) }),
    ),
  );
}

const startHistoryBus = (overrides: Parameters<typeof startTestBus>[0] = {}) =>
  startTestBus({ since: () => BASE_TIMESTAMP - 60, ...overrides });

const waitForSettled = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3_000, interval: 10 });

async function collectHistory(count: number) {
  const received: string[] = [];
  const historyErrors: string[] = [];
  const bus = await startHistoryBus({
    onMessage: async (message) => {
      received.push(message.text);
    },
    onHistoryError: (error) => {
      historyErrors.push(error.message);
    },
  });
  await waitForSettled(() => received.length >= count);
  await bus.close();
  return { received, historyErrors };
}

describe("Buzz reconnect history catch-up", () => {
  beforeEach(() => {
    history.historyRequests.length = 0;
    history.stallHistoryPages = false;
    history.closeHistoryPagesReason = undefined;
    history.overReturnHistoryPages = false;
    history.storedEvents = relayMocks.membershipEvents.map((event) => ({
      ...event,
      created_at: BASE_TIMESTAMP - 3_600,
    }));
    relayMocks.auth.mockResolvedValue("ok");
  });

  it.each([
    ["pages several history windows", 250, false, false],
    ["drains an overfull timestamp", HISTORY_LIMIT + 1, true, false],
    ["bisects overfull relay ranges", 1_300, false, true],
  ] as const)("%s", async (_name, count, sameTime, overReturn) => {
    seedOfflineBacklog(count, (index) => BASE_TIMESTAMP + (sameTime ? 0 : index));
    history.overReturnHistoryPages = overReturn;
    const { received, historyErrors } = await collectHistory(count);
    expect({ unique: new Set(received).size, count: received.length, historyErrors }).toEqual({
      unique: count,
      count,
      historyErrors: [],
    });
  });

  it.each(["times out", "closes unexpectedly"])("fails when catch-up %s", async (failure) => {
    const timesOut = failure === "times out";
    if (timesOut) {
      vi.useFakeTimers();
    }
    seedOfflineBacklog(HISTORY_LIMIT + 1, (index) => BASE_TIMESTAMP + index);
    history.stallHistoryPages = timesOut;
    history.closeHistoryPagesReason = timesOut ? undefined : "relay rejected subscription";
    const fatalErrors: string[] = [];

    const bus = await startHistoryBus({
      onFatalError: (error) => {
        fatalErrors.push(error.message);
      },
    });
    try {
      await (timesOut
        ? vi.advanceTimersByTimeAsync(10_000)
        : waitForSettled(() => fatalErrors.length > 0));
      if (!timesOut) {
        await bus.close();
      }
      expect(fatalErrors).toEqual([
        timesOut
          ? `Timed out loading Buzz room history for ${CHANNEL_ID}`
          : `Buzz room history query closed for ${CHANNEL_ID}: relay rejected subscription`,
      ]);
      expect(relayMocks.close).toHaveBeenCalled();
    } finally {
      await bus.close();
    }
  });

  it("does not request history when canceled after capacity resolves but before recovery resumes", async () => {
    const abort = new AbortController();
    const queue = createBuzzReplayDispatchQueue({ onTaskError: vi.fn() });
    const capacity = createDeferred<Awaited<ReturnType<typeof queue.reserveCapacity>>>();
    const reserving = createDeferred<void>();
    const onEvent = vi.fn();
    let tracker: Awaited<ReturnType<typeof createBuzzRoomMembershipTracker>> | undefined;
    try {
      seedOfflineBacklog(HISTORY_LIMIT + 1, (index) => BASE_TIMESTAMP + index);
      tracker = await createBuzzRoomMembershipTracker({
        relay: new Relay("wss://buzz.example.com"),
        relayPublicKey: fixture.RELAY_PUBLIC_KEY,
        channelIds: [CHANNEL_ID],
        botPublicKey: fixture.BOT_PUBLIC_KEY,
        since: BASE_TIMESTAMP - 60,
        messageSince: () => BASE_TIMESTAMP - 60,
        messageLimit: HISTORY_LIMIT,
        reserveDispatchCapacity: () => {
          reserving.resolve();
          return capacity.promise;
        },
        onMessageEvent: onEvent,
        signal: abort.signal,
      });
      history.historyRequests.length = 0;
      onEvent.mockClear();
      const reservation = await queue.reserveCapacity(HISTORY_LIMIT);
      expect(reservation).toBeDefined();
      const recovery = tracker.catchUpHistory();
      await reserving.promise;
      capacity.resolve(reservation);
      abort.abort();
      await expect(recovery).resolves.toBeUndefined();
      expect(history.historyRequests).toEqual([]);
      expect(onEvent).not.toHaveBeenCalled();
      const recoveredCapacity = await queue.reserveCapacity(BUZZ_REPLAY_DISPATCH_MAX_PENDING);
      expect(recoveredCapacity).toBeDefined();
      recoveredCapacity?.release();
    } finally {
      abort.abort();
      capacity.resolve(undefined);
      await tracker?.close();
      await queue.close();
    }
  });
});
