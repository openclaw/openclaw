import type { Filter, Relay } from "nostr-tools";
import { afterEach, expect, it, vi } from "vitest";
import { queryBuzzDirectoryRooms, startBuzzDirectoryRelay } from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";

type SubscriptionRecord = {
  filters: Filter[];
  handlers: Parameters<Relay["prepareSubscription"]>[1];
  close: ReturnType<typeof vi.fn>;
};
type Subscription = ReturnType<Relay["prepareSubscription"]>;

const BOT_PUBLIC_KEY = "a".repeat(64);
const RELAY_PUBLIC_KEY = "f".repeat(64);
const MEMBER_KEYS = ["b", "c"].map((key) => key.repeat(64));
const ROOM_IDS = ["7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c"];
const TIMEOUT = "Timed out loading Buzz directory snapshot";

function createProfileRelay(relayClose?: ReturnType<typeof vi.fn>) {
  const subscriptions: SubscriptionRecord[] = [];
  const relay = {
    ...(relayClose ? { close: relayClose } : {}),
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

it("replaces unfinished profile reads with the latest member set", () => {
  const { start, subscriptions } = createProfileRelay();
  const directory = start();
  for (const key of MEMBER_KEYS) {
    directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY, key]);
  }

  expect(subscriptions[1]?.filters[0]?.authors).toEqual([BOT_PUBLIC_KEY, MEMBER_KEYS[1]]);
  expect(subscriptions[0]?.close).toHaveBeenCalledOnce();
  expect(subscriptions[1]?.close).not.toHaveBeenCalled();

  directory.close();
  directory.replaceProfilePublicKeys([BOT_PUBLIC_KEY]);
  expect(subscriptions.map(({ close }) => close.mock.calls.length)).toEqual([1, 1]);
});

it("closes sibling profile subscriptions when one chunk fails", () => {
  const { start, subscriptions } = createProfileRelay();
  const directory = start();

  directory.replaceProfilePublicKeys(
    Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(64, "0")),
  );

  subscriptions[0]?.handlers.onclose?.("relay rejected subscription");

  expect(subscriptions[1]?.close).toHaveBeenCalledOnce();
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
  expect(subscriptions[0]?.close).not.toHaveBeenCalled();
  expect(relayClose).not.toHaveBeenCalled();

  directory.close();
});

it.each(["abort", "standalone", "active"])(
  "settles %s directory queries without closing before EOSE",
  async (mode) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const relayClose = vi.fn();
    const onFatalError = vi.fn();
    const { start, query, subscriptions } = createProfileRelay(relayClose);
    const result =
      mode === "active" ? start(onFatalError).refreshRooms(ROOM_IDS) : query(abort.signal);
    const rejection = expect(result).rejects.toThrow(mode === "abort" ? "stop" : TIMEOUT);
    if (mode === "abort") {
      abort.abort(new Error("stop"));
    } else {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await rejection;
    expect(onFatalError.mock.calls).toEqual(
      mode === "active" ? [[expect.objectContaining({ message: TIMEOUT })]] : [],
    );
    expect(subscriptions[0]?.close).not.toHaveBeenCalled();
    expect(relayClose).toHaveBeenCalledTimes(mode === "abort" ? 0 : 1);
    subscriptions[0]?.handlers.oneose?.();
    expect(subscriptions[0]?.close).toHaveBeenCalledOnce();
  },
);
