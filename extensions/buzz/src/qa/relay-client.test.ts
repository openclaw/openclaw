import { getPublicKey, type Event, type Filter, type Relay } from "nostr-tools";
import { beforeEach, expect, it, vi } from "vitest";
import { createBuzzRelayInfoFetchMock } from "../buzz-bus.test-helpers.js";
import { parseBuzzQaCredentialPayload } from "./credentials.js";

type SubscriptionHandlers = Parameters<Relay["prepareSubscription"]>[1];
const publicKey = (hex: string) =>
  getPublicKey(Uint8Array.from(Buffer.from(hex.repeat(32), "hex")));
const eventDefaults = { created_at: 1_750_000_000, sig: "e".repeat(128) };

const relayMocks = vi.hoisted(() => ({
  close: vi.fn(),
  publish: vi.fn(async () => "ok"),
  replayedMessage: undefined as Event | undefined,
}));

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      auth = vi.fn(async () => "ok");
      close = relayMocks.close;
      connect = vi.fn(async () => {});
      connected = true;
      ongoingOperations = 0;
      publish = relayMocks.publish;
      send = vi.fn(async () => {});
      subscriptionCount = 0;

      prepareSubscription(filters: Filter[], handlers: SubscriptionHandlers) {
        this.subscriptionCount++;
        if (filters[0]?.kinds?.includes(39002)) {
          handlers.onevent?.({
            ...eventDefaults,
            id: "membership",
            kind: 39002,
            pubkey: "f".repeat(64),
            content: "",
            tags: [
              ["d", "123e4567-e89b-42d3-a456-426614174000"],
              ["p", publicKey("01"), "", "member"],
              ["p", publicKey("02"), "", "bot"],
            ],
          });
        } else if (relayMocks.replayedMessage) {
          handlers.onevent?.(relayMocks.replayedMessage);
        }
        queueMicrotask(() => handlers.oneose?.());
        return { id: `sub:${this.subscriptionCount}`, close: vi.fn() };
      }
    },
  };
});

import { createBuzzQaRelayDriver } from "./relay-client.js";

const RELAY_PUBLIC_KEY = "f".repeat(64);
const credentials = parseBuzzQaCredentialPayload({
  relayUrl: "wss://relay.qa.example",
  roomId: "123e4567-e89b-42d3-a456-426614174000",
  driverPrivateKey: "01".repeat(32),
  sutPrivateKey: "02".repeat(32),
});

beforeEach(() => {
  vi.clearAllMocks();
  relayMocks.replayedMessage = undefined;
  vi.stubGlobal("fetch", createBuzzRelayInfoFetchMock(RELAY_PUBLIC_KEY));
});

it("authenticates, verifies membership, and publishes a native mentioned thread event", async () => {
  const driver = await createBuzzQaRelayDriver({ credentials, onMessage: vi.fn(async () => {}) });
  const sent = await driver.sendMessage({
    text: "@openclaw hello",
    mentionSut: true,
    threadId: "root-event",
    replyToId: "parent-event",
  });
  expect(sent.eventId).toMatch(/^[a-f0-9]{64}$/u);
  expect(relayMocks.publish).toHaveBeenCalledWith(
    expect.objectContaining({
      id: sent.eventId,
      kind: 9,
      content: "@openclaw hello",
      tags: [
        ["h", credentials.roomId],
        ["e", "root-event", "", "root"],
        ["e", "parent-event", "", "reply"],
        ["p", credentials.sutPublicKey],
      ],
    }),
  );
  await driver.close();
  expect(relayMocks.close).toHaveBeenCalledOnce();
});

it("ignores retained SUT messages before the observer reaches live events", async () => {
  const onMessage = vi.fn(async () => {});
  relayMocks.replayedMessage = {
    ...eventDefaults,
    id: "retained-sut-message",
    kind: 9,
    pubkey: credentials.sutPublicKey,
    content: "old response",
    tags: [["h", credentials.roomId]],
  };
  const driver = await createBuzzQaRelayDriver({ credentials, onMessage });
  expect(onMessage).not.toHaveBeenCalled();
  await driver.close();
});
