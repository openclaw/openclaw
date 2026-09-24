import type { Filter, Relay } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { openBuzzRelaySubscription, queryBuzzRelaySnapshot } from "./relay-subscription.js";

describe("openBuzzRelaySubscription", () => {
  it("sends an explicit REQ without synthesizing EOSE", async () => {
    vi.useFakeTimers();
    const oneose = vi.fn();
    const close = vi.fn();
    const subscription = {
      id: "sub:1",
      close,
    } as unknown as ReturnType<Relay["prepareSubscription"]>;
    const prepareSubscription = vi.fn(() => subscription);
    const send = vi.fn(async () => {});
    const relay = {
      idleSince: Date.now(),
      ongoingOperations: 0,
      prepareSubscription,
      send,
    } as unknown as Relay;
    const filters: Filter[] = [{ kinds: [0], authors: ["a".repeat(64)] }];

    const opened = openBuzzRelaySubscription(relay, filters, { oneose });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(opened).toBe(subscription);
    expect(prepareSubscription).toHaveBeenCalledWith(filters, { oneose });
    expect(send).toHaveBeenCalledWith(JSON.stringify(["REQ", "sub:1", ...filters]));
    expect(relay.ongoingOperations).toBe(1);
    expect(relay.idleSince).toBeUndefined();
    expect(oneose).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not close a subscription twice when sending fails after relay shutdown", async () => {
    let rejectSend: ((error: Error) => void) | undefined;
    const close = vi.fn();
    const subscription = {
      id: "sub:1",
      closed: false,
      close,
    } as unknown as ReturnType<Relay["prepareSubscription"]>;
    const openSubs = new Map([[subscription.id, subscription]]);
    const relay = {
      idleSince: undefined,
      ongoingOperations: 0,
      openSubs,
      prepareSubscription: vi.fn(() => subscription),
      send: vi.fn(
        async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectSend = reject;
          }),
      ),
    } as unknown as Relay;

    openBuzzRelaySubscription(relay, [{ kinds: [0] }], {});
    subscription.closed = true;
    openSubs.delete(subscription.id);
    rejectSend?.(new Error("socket closed"));
    await Promise.resolve();

    expect(close).not.toHaveBeenCalled();
  });
});

describe("queryBuzzRelaySnapshot", () => {
  it("shares the three reserved query slots and skips an aborted queued query", async () => {
    const replacementStarted = createDeferred<void>();
    const ready: Array<() => void> = [];
    const send = vi.fn(async () => {});
    const prepareSubscription = vi.fn((_filters: Filter[], handlers: { oneose: () => void }) => {
      ready.push(handlers.oneose);
      if (ready.length === 4) {
        replacementStarted.resolve();
      }
      return { id: String(ready.length), close: vi.fn(), closed: false };
    });
    const relay = {
      ongoingOperations: 0,
      idleSince: undefined,
      send,
      prepareSubscription,
    } as unknown as Relay;
    const query = (id: number, signal?: AbortSignal) =>
      queryBuzzRelaySnapshot({
        relay,
        filters: [{ ids: [String(id)] }],
        signal,
        timeoutMessage: "query timeout",
        abortMessage: "query aborted",
        failureMessage: "query failed",
        closeReason: "query complete",
        closeMessage: (reason) => reason,
        onEvent: () => {},
        result: () => id,
      });
    const active = [query(1), query(2), query(3)];
    const abort = new AbortController();
    const aborted = query(4, abort.signal);
    const queued = query(5);
    const abortedResult = expect(aborted).rejects.toThrow("cancelled before query");
    abort.abort(new Error("cancelled before query"));
    expect(prepareSubscription).toHaveBeenCalledTimes(3);
    ready[0]?.();
    await replacementStarted.promise;
    await abortedResult;
    expect(prepareSubscription).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith('["REQ","4",{"ids":["5"]}]');
    for (const finish of ready.slice(1)) {
      finish();
    }
    await expect(Promise.all([...active, queued])).resolves.toEqual([1, 2, 3, 5]);
  });
});
