import type { Event, SimplePool } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNostrRelaySubscriptionGroup } from "./nostr-relay-subscription.js";

type RelayHandlers = Parameters<SimplePool["subscribeMany"]>[2];

function createHarness() {
  const handlers: RelayHandlers[] = [];
  const abortController = new AbortController();
  const subscribeMany = vi.fn(
    (_relays: string[], _filter: unknown, nextHandlers: RelayHandlers) => {
      handlers.push(nextHandlers);
      const close = (reason: string) =>
        nextHandlers.onclose?.([{ url: "wss://test.example", reason }]);
      nextHandlers.abort?.addEventListener(
        "abort",
        () => close(String(nextHandlers.abort?.reason ?? "aborted")),
        { once: true },
      );
      return {
        close: vi.fn(async (reason?: string) => {
          close(reason ?? "closed by caller");
        }),
      };
    },
  );
  const onBackfillComplete = vi.fn<(relays: string[]) => void>();
  const onClose = vi.fn<(relay: string, reasons: string[]) => void>();
  const group = createNostrRelaySubscriptionGroup({
    pool: { subscribeMany } as unknown as SimplePool,
    relays: ["wss://one.example", "wss://two.example"],
    filter: { kinds: [4] },
    abort: abortController.signal,
    onEvent: (_event: Event) => {},
    onBackfillComplete,
    onClose,
  });
  group.start();
  return { abortController, group, handlers, onBackfillComplete, onClose, subscribeMany };
}

describe("Nostr relay subscriptions", () => {
  let harness: ReturnType<typeof createHarness>;
  const setup = () => (harness = createHarness());
  afterEach(async () => {
    try {
      await harness.group.close("test complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirms backfill only after every relay reports real EOSE", async () => {
    const { handlers, onBackfillComplete, subscribeMany } = setup();
    handlers[0]?.oneose?.();
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(subscribeMany.mock.calls.every(([relays]) => relays.length === 1)).toBe(true);
    expect(onBackfillComplete).toHaveBeenCalledWith(["wss://one.example", "wss://two.example"]);
  });

  it("does not confirm timeout-synthesized EOSE", async () => {
    vi.useFakeTimers();
    const { handlers, onBackfillComplete } = setup();
    await vi.advanceTimersByTimeAsync(10_000);
    handlers[0]?.oneose?.();
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(onBackfillComplete).not.toHaveBeenCalled();
  });

  it("lets same-turn close veto the pool's synthetic EOSE", async () => {
    const { handlers, onBackfillComplete } = setup();
    handlers[0]?.oneose?.();
    handlers[0]?.onclose?.([{ url: "wss://one.example", reason: "relay closed" }]);
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(onBackfillComplete).not.toHaveBeenCalled();
  });

  it("does not report locally requested closes as relay failures", async () => {
    const { abortController, group, onClose } = setup();
    abortController.abort("closed by caller");
    await group.close("closed by caller");

    expect(onClose).not.toHaveBeenCalled();
  });

  it("still reports closes initiated by the relay", async () => {
    const { handlers, onClose } = setup();
    handlers[0]?.onclose?.([{ url: "wss://one.example", reason: "relay unavailable" }]);

    expect(onClose).toHaveBeenCalledWith("wss://one.example", ["relay unavailable"]);
  });
});
