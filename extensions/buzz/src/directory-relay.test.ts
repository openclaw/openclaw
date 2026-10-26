import type { Event, Filter, Relay } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryBuzzDirectoryRooms, startBuzzDirectoryRelay } from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";

type SubscriptionRecord = {
  filters: Filter[];
  handlers: {
    onevent: (event: Event) => void;
    oneose?: () => void;
    onclose: (reason: string) => void;
  };
  close: ReturnType<typeof vi.fn>;
};
type Subscription = ReturnType<Relay["prepareSubscription"]>;

const BOT_PUBLIC_KEY = "a".repeat(64);
const RELAY_PUBLIC_KEY = "f".repeat(64);
const MEMBER_KEYS = ["b", "c", "d"].map((key) => key.repeat(64));
const ROOM_IDS = ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"];

function createProfileRelay(relayClose?: ReturnType<typeof vi.fn>) {
  const subscriptions: SubscriptionRecord[] = [];
  const relay = {
    ...(relayClose ? { close: relayClose } : {}),
    idleSince: undefined,
    ongoingOperations: 0,
    prepareSubscription: vi.fn((filters: Filter[], handlers: SubscriptionRecord["handlers"]) => {
      const close = vi.fn();
      subscriptions.push({ filters, handlers, close });
      return { id: `sub:${subscriptions.length}`, close } as unknown as Subscription;
    }),
    send: vi.fn(async () => {}),
  } as unknown as Relay;
  const params = {
    relay,
    relayPublicKey: RELAY_PUBLIC_KEY,
    state: new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [],
    }),
  };
  return {
    subscriptions,
    start: (onFatalError?: (error: Error) => void) =>
      startBuzzDirectoryRelay({ ...params, subscribedRoomIds: new Set(), onFatalError }),
    query: (signal?: AbortSignal) =>
      queryBuzzDirectoryRooms({ ...params, channelIds: ROOM_IDS, signal }),
  };
}

afterEach(() => vi.useRealTimers());

describe("Buzz directory relay", () => {
  it("replaces unfinished profile reads with the latest member set", () => {
    const { start, subscriptions } = createProfileRelay();
    const directory = start();
    for (const key of MEMBER_KEYS) {
      directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, key]);
    }

    expect(subscriptions).toHaveLength(3);
    expect(subscriptions[2]?.filters[0]?.authors).toEqual([BOT_PUBLIC_KEY, MEMBER_KEYS[2]]);
    expect(subscriptions.map(({ close }) => close.mock.calls)).toEqual([
      [["directory profile subscription replaced"]],
      [["directory profile subscription replaced"]],
      [],
    ]);

    directory.close();
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY]);
    expect(subscriptions).toHaveLength(3);
    expect(subscriptions.map(({ close }) => close.mock.calls.length)).toEqual([1, 1, 1]);
    expect(subscriptions[2]?.close).toHaveBeenCalledWith("directory shutdown");
  });

  it("closes sibling profile subscriptions when one chunk fails", () => {
    const { start, subscriptions } = createProfileRelay();
    const directory = start();

    directory.replaceProfilePublicKeys(
      Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(64, "0")),
    );
    expect(subscriptions).toHaveLength(2);

    subscriptions[0]?.handlers.onclose("relay rejected subscription");

    expect(subscriptions[1]?.close).toHaveBeenCalledWith(
      "directory profile subscription generation failed",
    );
  });

  it("keeps the relay running when optional profile reads never reach EOSE", async () => {
    vi.useFakeTimers();
    const relayClose = vi.fn();
    const onFatalError = vi.fn();
    const { start, subscriptions } = createProfileRelay(relayClose);
    const directory = start(onFatalError);

    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, MEMBER_KEYS[0]!]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onFatalError).not.toHaveBeenCalled();
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.close).not.toHaveBeenCalled();
    expect(relayClose).not.toHaveBeenCalled();

    directory.close();
    expect(subscriptions[0]?.close).toHaveBeenCalledExactlyOnceWith("directory shutdown");
  });

  it("defers query cleanup until the relay confirms EOSE", async () => {
    const abort = new AbortController();
    const { query, subscriptions } = createProfileRelay();
    const result = query(abort.signal);

    abort.abort(new Error("stop"));
    await expect(result).rejects.toThrow("stop");
    expect(subscriptions[0]?.close).not.toHaveBeenCalled();

    subscriptions[0]?.handlers.oneose?.();
    expect(subscriptions[0]?.close).toHaveBeenCalledWith("directory query complete");
  });

  it.each(["standalone", "active"])(
    "recycles a stalled %s directory query without closing before EOSE",
    async (mode) => {
      vi.useFakeTimers();
      const relayClose = vi.fn();
      const onFatalError = vi.fn();
      const { start, query, subscriptions } = createProfileRelay(relayClose);
      const result = mode === "active" ? start(onFatalError).refreshRooms(ROOM_IDS) : query();
      const rejection = expect(result).rejects.toThrow("Timed out loading Buzz directory snapshot");

      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;

      expect(onFatalError.mock.calls).toEqual(
        mode === "active"
          ? [[expect.objectContaining({ message: "Timed out loading Buzz directory snapshot" })]]
          : [],
      );
      expect(subscriptions[0]?.close).not.toHaveBeenCalled();
      expect(relayClose).toHaveBeenCalledOnce();
    },
  );
});
