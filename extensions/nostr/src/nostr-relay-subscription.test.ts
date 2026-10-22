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
        close: vi.fn(async (reason = "closed by caller") => close(reason)),
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

  it.each(["timeout", "same-turn close"])("rejects synthetic EOSE after %s", async (cause) => {
    if (cause === "timeout") {
      vi.useFakeTimers();
    }
    const { handlers, onBackfillComplete } = setup();
    if (cause === "timeout") {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    handlers[0]?.oneose?.();
    if (cause === "same-turn close") {
      handlers[0]?.onclose?.([{ url: "wss://one.example", reason: "relay closed" }]);
    }
    handlers[1]?.oneose?.();
    await Promise.resolve();

    expect(onBackfillComplete).not.toHaveBeenCalled();
  });

  it.each([true, false])("reports closure only for remote initiators (local=%s)", async (local) => {
    const { abortController, group, handlers, onClose } = setup();
    if (local) {
      abortController.abort("closed by caller");
      await group.close("closed by caller");
    } else {
      handlers[0]?.onclose?.([{ url: "wss://one.example", reason: "relay unavailable" }]);
    }
    expect(onClose.mock.calls).toEqual(local ? [] : [["wss://one.example", ["relay unavailable"]]]);
  });
});
