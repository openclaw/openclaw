import type { Relay } from "nostr-tools";
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
  it("keeps queries pending until real EOSE while canceling queued work without losing capacity", async () => {
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
    relay.idleSince = Date.now();
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
      await vi.advanceTimersByTimeAsync(5_000);
      expect(prepareSubscription).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenNthCalledWith(1, '["REQ","1",{"ids":["1"]}]');
      expect(relay).toMatchObject({ ongoingOperations: 3, idleSince: undefined });
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
