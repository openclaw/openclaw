import type { Event, SimplePool } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNostrRelaySubscriptionGroup } from "./nostr-relay-subscription.js";

type RelayHandlers = Parameters<SimplePool["subscribeMany"]>[2];

function createHarness(filter: Parameters<SimplePool["subscribeMany"]>[1] = { kinds: [4] }) {
  const handlers: RelayHandlers[] = [];
  const abortController = new AbortController();
  const subscribeMany = vi.fn(
    (_relays: string[], _filter: unknown, nextHandlers: RelayHandlers) => {
      handlers.push(nextHandlers);
      nextHandlers.abort?.addEventListener(
        "abort",
        () =>
          nextHandlers.onclose?.([
            {
              url: "wss://test.example",
              reason: String(nextHandlers.abort?.reason ?? "aborted"),
            },
          ]),
        { once: true },
      );
      return {
        close: vi.fn(async (reason?: string) => {
          nextHandlers.onclose?.([
            { url: "wss://test.example", reason: reason ?? "closed by caller" },
          ]);
        }),
      };
    },
  );
  const onBackfillComplete = vi.fn<(relays: string[]) => void>();
  const onClose = vi.fn<(relay: string, reasons: string[]) => void>();
  const group = createNostrRelaySubscriptionGroup({
    pool: { subscribeMany } as unknown as SimplePool,
    relays: ["wss://one.example", "wss://two.example"],
    filter,
    replayLookbackSec: 120,
    abort: abortController.signal,
    onEvent: (_event: Event) => {},
    onBackfillComplete,
    onClose,
  });
  group.start();
  return { abortController, group, handlers, onBackfillComplete, onClose, subscribeMany };
}

describe("Nostr relay subscriptions", () => {
  afterEach(() => vi.useRealTimers());

  it("confirms backfill only after every relay reports real EOSE", async () => {
    const { group, handlers, onBackfillComplete, subscribeMany } = createHarness();

    handlers[0]?.oneose?.();
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(subscribeMany.mock.calls.every(([relays]) => relays.length === 1)).toBe(true);
    expect(onBackfillComplete).toHaveBeenCalledWith(["wss://one.example", "wss://two.example"]);
    await group.close("test complete");
  });

  it("does not confirm timeout-synthesized EOSE", async () => {
    vi.useFakeTimers();
    const { group, handlers, onBackfillComplete } = createHarness();

    await vi.advanceTimersByTimeAsync(10_000);
    handlers[0]?.oneose?.();
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(onBackfillComplete).not.toHaveBeenCalled();
    await group.close("test complete");
  });

  it("lets same-turn close veto the pool's synthetic EOSE", async () => {
    const { group, handlers, onBackfillComplete } = createHarness();

    handlers[0]?.oneose?.();
    handlers[0]?.onclose?.([{ url: "wss://one.example", reason: "relay closed" }]);
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(onBackfillComplete).not.toHaveBeenCalled();
    await group.close("test complete");
  });

  it("does not report locally requested closes as relay failures", async () => {
    const { abortController, group, onClose } = createHarness();

    abortController.abort("closed by caller");
    await group.close("closed by caller");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("still reports closes initiated by the relay", async () => {
    const { group, handlers, onClose } = createHarness();

    handlers[0]?.onclose?.([{ url: "wss://one.example", reason: "relay unavailable" }]);

    expect(onClose).toHaveBeenCalledWith("wss://one.example", ["relay unavailable"]);
    await group.close("test complete");
  });

  it("resubscribes a relay whose subscription closes unexpectedly", async () => {
    vi.useFakeTimers();
    const { group, handlers, onClose, subscribeMany } = createHarness();

    handlers[1]?.onclose?.([{ url: "wss://two.example", reason: "relay connection failed" }]);
    expect(onClose).toHaveBeenCalledWith("wss://two.example", ["relay connection failed"]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(subscribeMany).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(subscribeMany).toHaveBeenCalledTimes(3);
    expect(subscribeMany.mock.calls[2]?.[0]).toEqual(["wss://two.example"]);
    await group.close("test complete");
  });

  it("resubscribes with a bounded replay window that keeps the skew lookback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(10_000_000);
    const { group, handlers, subscribeMany } = createHarness({ kinds: [4], since: 1_000 });

    handlers[0]?.onevent?.({ created_at: 9_000 } as Event); // stored, before EOSE: ignored
    handlers[0]?.oneose?.();
    handlers[1]?.oneose?.();
    await Promise.resolve();
    handlers[0]?.onevent?.({ created_at: 2_000 } as Event);
    handlers[1]?.onevent?.({ created_at: 1_050 } as Event);
    handlers[0]?.onclose?.([{ url: "wss://one.example", reason: "relay connection failed" }]);
    handlers[1]?.onclose?.([{ url: "wss://two.example", reason: "relay connection failed" }]);
    await vi.advanceTimersByTimeAsync(10_000);

    const resubscribed = new Map(
      subscribeMany.mock.calls.slice(2).map(([relays, filter]) => [relays[0], filter]),
    );
    // A DM stamped 1_990 by a sender whose clock is behind still matches; older history is not replayed.
    expect(resubscribed.get("wss://one.example")).toEqual({ kinds: [4], since: 1_880 });
    // Never earlier than the startup baseline.
    expect(resubscribed.get("wss://two.example")).toEqual({ kinds: [4], since: 1_000 });
    await group.close("test complete");
  });

  it("clamps a far-future event before it moves the replay window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(2_000_000);
    const { group, handlers, subscribeMany } = createHarness({ kinds: [4], since: 1_000 });

    handlers[1]?.oneose?.();
    await Promise.resolve();
    handlers[1]?.onevent?.({ created_at: 9_999_999 } as Event);
    handlers[1]?.onclose?.([{ url: "wss://two.example", reason: "relay connection failed" }]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(subscribeMany.mock.calls[2]?.[1]).toEqual({ kinds: [4], since: 1_880 });
    await group.close("test complete");
  });

  it("does not resubscribe once the group is closing", async () => {
    vi.useFakeTimers();
    const { group, handlers, subscribeMany } = createHarness();

    handlers[1]?.onclose?.([{ url: "wss://two.example", reason: "relay connection failed" }]);
    await group.close("closed by caller");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(subscribeMany).toHaveBeenCalledTimes(2);
  });
});
