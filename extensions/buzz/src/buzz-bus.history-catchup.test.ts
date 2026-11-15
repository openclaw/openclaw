import { matchFilter, Relay, type Event, type Filter } from "nostr-tools";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createOutboundTestPlugin,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const history = vi.hoisted(() => ({
  storedEvents: [] as Event[],
  historyRequests: [] as Filter[],
  stallHistoryPages: false,
  closeHistoryPagesReason: undefined as string | undefined,
  overReturnHistoryPages: false,
  rateLimits: 0,
  rateLimitReason: "",
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return {
    ...(await importOriginal<typeof import("nostr-tools")>()),
    ...mockBuzzRelay((filters, handlers) => {
      const pages = filters.filter((filter) => filter.kinds?.includes(9));
      history.historyRequests.push(...pages);
      const isHistoryPage = pages.some((filter) => filter.until !== undefined);
      const limited =
        isHistoryPage &&
        pages.some((filter) => filter["#h"]?.includes(CHANNEL_ID)) &&
        history.rateLimits-- > 0;
      for (const filter of filters) {
        const events = history.storedEvents
          .filter((event) => matchFilter(filter, event))
          .toSorted((a, b) => b.created_at - a.created_at);
        const limit =
          history.overReturnHistoryPages && isHistoryPage ? events.length : filter.limit;
        events.slice(0, limit).forEach(handlers.onevent);
      }
      const reason = limited
        ? `rate-limited: ${history.rateLimitReason}`
        : history.closeHistoryPagesReason;
      if (isHistoryPage && reason) {
        queueMicrotask(() => handlers.onclose(reason));
      } else if (!isHistoryPage || !history.stallHistoryPages) {
        queueMicrotask(() => handlers.oneose?.());
      }
      return { id: `sub:${history.historyRequests.length}`, close: vi.fn(), closed: false };
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

function seedOfflineBacklog(count: number, at: (i: number) => number, room = CHANNEL_ID) {
  history.storedEvents.push(
    ...Array.from({ length: count }, (_, index) =>
      senderMessage(`${room}-${index}`, { created_at: at(index), tags: [["h", room]] }),
    ),
  );
}
const startHistoryBus = (overrides: Parameters<typeof startTestBus>[0] = {}) =>
  startTestBus({ since: () => BASE_TIMESTAMP - 60, ...overrides });
const waitForSettled = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3_000, interval: 10 });

describe("Buzz reconnect history catch-up", () => {
  afterEach(resetPluginRuntimeStateForTest);
  beforeEach(() => {
    history.historyRequests.length = 0;
    history.stallHistoryPages = false;
    history.closeHistoryPagesReason = undefined;
    history.overReturnHistoryPages = false;
    history.rateLimits = 0;
    history.storedEvents = relayMocks.membershipEvents.slice();
    relayMocks.auth.mockResolvedValue("ok");
  });

  it.each([
    ["pages several history windows", 250, false, false, 1],
    ["drains an overfull timestamp", HISTORY_LIMIT + 1, true, false, 4],
    ["bisects overfull relay ranges", 1_300, false, true, 1],
  ] as const)(
    "%s while another room is rate-limited",
    async (_name, count, sameTime, overReturn, rejections) => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      const roomB = "940d0c32-4eb7-46d7-9d5b-d975aaef87f7";
      const roster = history.storedEvents[0]!;
      history.storedEvents.push({
        ...roster,
        id: "room-b-roster",
        tags: roster.tags.map((tag) => (tag[0] === "d" ? ["d", roomB] : tag)),
      });
      seedOfflineBacklog(HISTORY_LIMIT + 1, (index) => BASE_TIMESTAMP + index);
      seedOfflineBacklog(count, (index) => BASE_TIMESTAMP + (sameTime ? 0 : index), roomB);
      history.overReturnHistoryPages = overReturn;
      history.rateLimits = rejections;
      history.rateLimitReason = rejections === 4 ? "Retry-After: 60" : "retry in 1m";
      const received: string[] = [];
      const fatal = vi.fn();
      const incomplete = vi.fn();
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "line",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "line",
              outbound: {
                deliveryMode: "direct",
                sendText: async () => ({ channel: "line", messageId: "line-reply" }),
              },
            }),
          },
        ]),
      );
      const bus = await startHistoryBus({
        channelIds: [CHANNEL_ID, roomB],
        onMessage: async (message) => {
          received.push(message.text);
        },
        onFatalError: fatal,
        onHistoryError: incomplete,
      });
      await vi.advanceTimersByTimeAsync(0);
      await waitForSettled(
        () => received.filter((text) => text.startsWith(roomB)).length === count,
      );
      expect(
        await sendDurableMessageBatch({
          cfg: {},
          channel: "line",
          to: "other-channel",
          payloads: [{ text: "unaffected reply" }],
          skipQueue: true,
        }),
      ).toMatchObject({ status: "sent", results: [{ channel: "line", messageId: "line-reply" }] });
      await expect(
        bus.sendText({ channelId: roomB, text: "healthy room reply" }),
      ).resolves.toBeTruthy();
      const queries = () =>
        history.historyRequests.filter(
          (filter) => filter.until !== undefined && filter["#h"]?.includes(CHANNEL_ID),
        ).length;
      expect(queries()).toBe(1);
      await vi.advanceTimersByTimeAsync(59_999 - (Date.now() - startedAt));
      expect(queries()).toBe(1);
      await vi.advanceTimersByTimeAsync(120_001);
      const expected = count + HISTORY_LIMIT + (rejections === 1 ? 1 : 0);
      await waitForSettled(() => received.length === expected);
      expect(new Set(received).size).toBe(expected);
      expect(fatal).not.toHaveBeenCalled();
      expect(relayMocks.close).not.toHaveBeenCalled();
      expect(incomplete).toHaveBeenCalledTimes(rejections === 4 ? 1 : 0);
      await expect(
        bus.sendText({ channelId: roomB, text: "still replying" }),
      ).resolves.toBeTruthy();
    },
  );

  it.each(["times out", "closes unexpectedly"])("fails when catch-up %s", async (failure) => {
    vi.useFakeTimers();
    seedOfflineBacklog(HISTORY_LIMIT + 1, (index) => BASE_TIMESTAMP + index);
    history.stallHistoryPages = failure === "times out";
    history.closeHistoryPagesReason = history.stallHistoryPages
      ? undefined
      : "relay rejected subscription";
    const fatal = vi.fn();
    await startHistoryBus({ onFatalError: fatal });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fatal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: history.stallHistoryPages
          ? `Timed out loading Buzz room history for ${CHANNEL_ID}`
          : `Buzz room history query closed for ${CHANNEL_ID}: relay rejected subscription`,
      }),
    );
    expect(relayMocks.close).toHaveBeenCalled();
  });

  it("does not request history when canceled after capacity resolves but before recovery resumes", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const queue = createBuzzReplayDispatchQueue({ onTaskError: vi.fn() });
    const capacity = createDeferred<Awaited<ReturnType<typeof queue.reserveCapacity>>>();
    const reserve = vi.fn(() => capacity.promise);
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
        reserveDispatchCapacity: reserve,
        onMessageEvent: onEvent,
        signal: abort.signal,
      });
      history.historyRequests.length = 0;
      onEvent.mockClear();
      const reservation = await queue.reserveCapacity(HISTORY_LIMIT);
      expect(reservation).toBeDefined();
      const recovery = tracker.catchUpHistory();
      await waitForSettled(() => reserve.mock.calls.length === 1);
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
