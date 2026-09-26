import type { Filter, Relay } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import {
  openBuzzRelaySubscription,
  queryBuzzRelaySnapshot,
  resolveBuzzRelayRetryDelayMs,
} from "./relay-subscription.js";

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

describe("resolveBuzzRelayRetryDelayMs", () => {
  // Drive the real path: the relay CLOSEs a snapshot subscription, and whatever error
  // that produces is what classification has to work with.
  async function closedByRelay(reason: string): Promise<unknown> {
    const relay = {
      idleSince: Date.now(),
      ongoingOperations: 0,
      openSubs: new Map(),
      scheduleIdleClose: vi.fn(),
      close: vi.fn(),
      send: async () => {},
      prepareSubscription: (
        _filters: Filter[],
        handlers: { onclose: (reason: string) => void },
      ) => {
        queueMicrotask(() => handlers.onclose(reason));
        return { id: "sub:1", close: vi.fn(), closed: false };
      },
    } as unknown as Relay;
    return await queryBuzzRelaySnapshot({
      relay,
      filters: [{ kinds: [9] }],
      timeoutMessage: "Timed out loading Buzz room history for room",
      abortMessage: "Buzz room history query aborted",
      failureMessage: "Buzz room history query failed",
      closeReason: "buzz room history page loaded",
      closeMessage: (closeReason) => `Buzz room history query closed for room: ${closeReason}`,
      onEvent: () => {},
      result: () => null,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it.each([
    ["rate-limited: quota exceeded; retry in 2s", 2_000],
    ["rate-limited: quota exceeded; retry in 3s", 3_000],
    ["RATE-LIMITED: slow down; retry in 500ms", 500],
    ["rate-limited: slow down", 2_000],
    ["rate-limited: retry in 1m", 60_000],
    ["rate-limited: retry in 90s", 90_000],
    ["rate-limited: retry in 10m", 300_000],
    ["rate-limited: retry in 0s", 2_000],
  ])("treats %s as retryable after %ims", async (reason, expected) => {
    expect(resolveBuzzRelayRetryDelayMs(await closedByRelay(reason))).toBe(expected);
  });

  it.each([
    "relay rejected subscription",
    "invalid: unknown filter",
    "blocked: not a member",
    "shutdown",
    "connection closed while rate-limited: quota exceeded",
  ])("does not retry %s", async (reason) => {
    expect(resolveBuzzRelayRetryDelayMs(await closedByRelay(reason))).toBeUndefined();
  });

  it("does not retry an error that is not a relay subscription close", () => {
    expect(
      resolveBuzzRelayRetryDelayMs(new Error("rate-limited: quota exceeded; retry in 2s")),
    ).toBeUndefined();
  });
});
