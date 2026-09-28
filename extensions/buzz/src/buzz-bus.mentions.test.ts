import { nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return { ...(await importOriginal<typeof import("nostr-tools")>()), ...mockBuzzRelay() };
});

import { useBuzzBusLifecycleFixture } from "./buzz-bus.lifecycle.test-harness.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";

const {
  CHANNEL_ID,
  BOT_PUBLIC_KEY,
  SENDER_PUBLIC_KEY,
  RELAY_PUBLIC_KEY,
  startTestBus,
  sendTestTextOneShot,
  signSenderEvent,
  subscriptionIncludesKind,
} = useBuzzBusLifecycleFixture();

describe("Buzz mention delivery", () => {
  beforeEach(() => {
    relayMocks.auth.mockResolvedValue("ok");
  });

  it("resolves standalone native mentions from the room snapshot before publishing", async () => {
    relayMocks.profileEvents = [
      signSenderEvent({
        kind: 0,
        created_at: 1_700_000_000,
        content: JSON.stringify({ display_name: "Alice" }),
        tags: [],
      }),
    ];

    await sendTestTextOneShot({
      text: "Hello @Alice",
      threadId: "root-id",
    });

    expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9,
      content: "Hello @Alice",
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "reply"],
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 39002))).toBe(
      true,
    );
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 0))).toBe(true);
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("skips profile discovery for an explicit standalone NIP-27 mention", async () => {
    await sendTestTextOneShot({
      text: `Hello nostr:${nip19.npubEncode(SENDER_PUBLIC_KEY)}`,
    });

    expect(relayMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 9,
      tags: [
        ["h", CHANNEL_ID],
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 39002))).toBe(
      true,
    );
    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 0))).toBe(
      false,
    );
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("closes a standalone relay when mention preflight rejects the message", async () => {
    await expect(
      sendTestTextOneShot({
        text: "Hello @Missing",
      }),
    ).rejects.toThrow('Buzz mention "@missing" does not match a current room member');

    expect(relayMocks.publish).not.toHaveBeenCalled();
    expect(relayMocks.close).toHaveBeenCalledOnce();
  });

  it("resolves active-bus mentions for proactive sends and agent replies", async () => {
    relayMocks.profileEvents = [
      signSenderEvent({
        kind: 0,
        created_at: 1_700_000_000,
        content: JSON.stringify({ display_name: "Alice" }),
        tags: [],
      }),
    ];
    const bus = await startTestBus();

    await bus.sendText({
      channelId: CHANNEL_ID,
      text: "Hello @Alice",
      threadId: "root-id",
      replyToId: "parent-id",
    });

    const event = relayMocks.publish.mock.calls
      .map(([published]) => published)
      .find((published) => published.kind === 9);
    expect(event).toMatchObject({
      kind: 9,
      content: "Hello @Alice",
      tags: [
        ["h", CHANNEL_ID],
        ["e", "root-id", "", "root"],
        ["e", "parent-id", "", "reply"],
        ["p", SENDER_PUBLIC_KEY],
      ],
    });
    expect(relayMocks.connect).toHaveBeenCalledOnce();

    await bus.close();
  });

  it("stops mentioning a removed member before the signed roster refresh completes", async () => {
    const explicitSender = `nostr:${nip19.npubEncode(SENDER_PUBLIC_KEY)}`;
    const bus = await startTestBus();

    await bus.sendText({ channelId: CHANNEL_ID, text: explicitSender });
    relayMocks.publish.mockClear();
    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 40_099))
      ?.handlers.onevent({
        id: "member-removed-1",
        kind: 40_099,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_001,
        content: JSON.stringify({ type: "member_removed", target: SENDER_PUBLIC_KEY }),
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      });

    expect(bus.directory.mentionMembers(CHANNEL_ID)).toEqual([
      expect.objectContaining({ publicKey: BOT_PUBLIC_KEY }),
    ]);
    await expect(bus.sendText({ channelId: CHANNEL_ID, text: explicitSender })).rejects.toThrow(
      "is not a current room member",
    );
    expect(relayMocks.publish).not.toHaveBeenCalled();

    await bus.close();
  });

  it("keeps mention-free active sends off the room roster path", async () => {
    const bus = await startTestBus();
    const mentionMembers = vi.spyOn(bus.directory, "mentionMembers");

    await bus.sendText({
      channelId: CHANNEL_ID,
      text: "Plain message without a mention",
    });

    expect(mentionMembers).not.toHaveBeenCalled();
    expect(relayMocks.publish.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 9,
      tags: [["h", CHANNEL_ID]],
    });

    await bus.close();
  });
});
