import type { Filter, Relay } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBuzzRelaySubscription, queryBuzzRelaySnapshot } from "./relay-subscription.js";

type Subscription = ReturnType<Relay["prepareSubscription"]>;
const subscription = (id = "sub:1") =>
  ({ id, closed: false, close: vi.fn() }) as unknown as Subscription;
function relayFixture(sub = subscription()) {
  const send = vi.fn(async () => {});
  const prepareSubscription = vi.fn<Relay["prepareSubscription"]>(() => sub);
  const transport = { prepareSubscription, send, openSubs: new Map([[sub.id, sub]]) };
  const relay = { ...transport, idleSince: undefined, ongoingOperations: 0 } as unknown as Relay;
  return { relay, sub, ...transport };
}

describe("Buzz relay subscriptions", () => {
  afterEach(() => vi.useRealTimers());
  it("sends an explicit REQ without synthesizing EOSE", async () => {
    vi.useFakeTimers();
    const oneose = vi.fn();
    const { relay, sub, send, prepareSubscription } = relayFixture();
    relay.idleSince = Date.now();
    const filters: Filter[] = [{ kinds: [0], authors: ["a".repeat(64)] }];

    expect(openBuzzRelaySubscription(relay, filters, { oneose })).toBe(sub);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(prepareSubscription).toHaveBeenCalledWith(filters, { oneose });
    expect(send).toHaveBeenCalledWith(JSON.stringify(["REQ", "sub:1", ...filters]));
    expect(relay).toMatchObject({ ongoingOperations: 1, idleSince: undefined });
    expect(oneose).not.toHaveBeenCalled();
  });

  it("does not close a subscription twice when sending fails after relay shutdown", async () => {
    const pending = createDeferred<void>();
    const { relay, sub, send } = relayFixture();
    const close = vi.spyOn(sub, "close");
    send.mockImplementation(async () => await pending.promise);

    openBuzzRelaySubscription(relay, [{ kinds: [0] }], {});
    sub.closed = true;
    relay.openSubs.delete(sub.id);
    pending.reject(new Error("socket closed"));
    await Promise.resolve();

    expect(close).not.toHaveBeenCalled();
  });
  it("cancels a queued query while all three slots stay occupied and preserves capacity", async () => {
    vi.useFakeTimers();
    const cleanup = new AbortController();
    const replacementStarted = createDeferred<void>();
    const ready: Array<() => void> = [];
    const { relay, send, prepareSubscription } = relayFixture();
    prepareSubscription.mockImplementation((_filters, handlers) => {
      ready.push(handlers.oneose!);
      if (ready.length === 4) {
        replacementStarted.resolve();
      }
      return subscription(String(ready.length));
    });
    const query = (id: number, signal = cleanup.signal) =>
      queryBuzzRelaySnapshot({
        relay,
        filters: [{ ids: [String(id)] }],
        signal,
        timeoutMessage: "query timeout",
        abortMessage: "query aborted",
        closeReason: "query complete",
        closeMessage: (reason) => reason,
        onEvent: () => {},
        result: () => id,
      });
    const active = [query(1), query(2), query(3)];
    const abort = new AbortController();
    const onAborted = vi.fn();
    const aborted = query(4, abort.signal).catch(onAborted);
    const queued = query(5);
    const reason = new Error("cancelled before query");
    try {
      const beforeAbort = Date.now();
      abort.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      expect(Date.now()).toBe(beforeAbort);
      expect(onAborted).toHaveBeenCalledExactlyOnceWith(reason);
      expect(prepareSubscription).toHaveBeenCalledTimes(3);
      ready[0]?.();
      await replacementStarted.promise;
      await aborted;
      expect(prepareSubscription).toHaveBeenCalledTimes(4);
      expect(send).toHaveBeenLastCalledWith('["REQ","4",{"ids":["5"]}]');
      ready.slice(1).forEach((finish) => finish());
      await expect(Promise.all([...active, queued])).resolves.toEqual([1, 2, 3, 5]);
    } finally {
      cleanup.abort(new Error("test cleanup"));
      abort.abort(reason);
      await Promise.allSettled([...active, aborted, queued]);
    }
  });
});
