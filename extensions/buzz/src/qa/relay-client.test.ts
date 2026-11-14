import type { Event } from "nostr-tools";
import { beforeEach, expect, it, vi } from "vitest";
import { createBuzzRelayInfoFetchMock, relayMocks } from "../buzz-bus.test-helpers.js";
import { parseBuzzQaCredentialPayload } from "./credentials.js";

let replayedMessage: Event | undefined;

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("../buzz-bus.test-helpers.js");
  return {
    ...(await importOriginal<typeof import("nostr-tools")>()),
    ...mockBuzzRelay((filters, handlers) => {
      const membership = filters[0]?.kinds?.includes(39002);
      const event = membership ? membershipEvent : replayedMessage;
      if (event) {
        handlers.onevent(event);
      }
      queueMicrotask(() => handlers.oneose?.());
      return { id: membership ? "membership" : "observer", close: vi.fn(), closed: false };
    }),
  };
});

import { createBuzzQaRelayDriver } from "./relay-client.js";

const credentials = parseBuzzQaCredentialPayload({
  relayUrl: "wss://relay.qa.example",
  roomId: "123e4567-e89b-42d3-a456-426614174000",
  driverPrivateKey: "01".repeat(32),
  sutPrivateKey: "02".repeat(32),
});
const membershipEvent: Event = {
  created_at: 1_750_000_000,
  sig: "e".repeat(128),
  id: "membership",
  kind: 39002,
  pubkey: "f".repeat(64),
  content: "",
  tags: [
    ["d", credentials.roomId],
    ["p", credentials.driverPublicKey, "", "member"],
    ["p", credentials.sutPublicKey, "", "bot"],
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  replayedMessage = undefined;
  relayMocks.auth.mockResolvedValue("ok");
  relayMocks.send.mockResolvedValue();
  vi.stubGlobal("fetch", createBuzzRelayInfoFetchMock(membershipEvent.pubkey));
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
  expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
    id: sent.eventId,
    kind: 9,
    content: "@openclaw hello",
    tags: [
      ["h", credentials.roomId],
      ["e", "root-event", "", "root"],
      ["e", "parent-event", "", "reply"],
      ["p", credentials.sutPublicKey],
    ],
  });
  await driver.close();
  expect(relayMocks.close).toHaveBeenCalledOnce();
});

it("ignores retained SUT messages before the observer reaches live events", async () => {
  const onMessage = vi.fn(async () => {});
  replayedMessage = {
    ...membershipEvent,
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
