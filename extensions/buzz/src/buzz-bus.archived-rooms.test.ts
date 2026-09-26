import type { Event } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("nostr-tools", async (importOriginal) => {
  const { mockBuzzRelay } = await import("./buzz-bus.test-helpers.js");
  return { ...(await importOriginal<typeof import("nostr-tools")>()), ...mockBuzzRelay() };
});

import { useBuzzBusLifecycleFixture } from "./buzz-bus.lifecycle.test-harness.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";
import { BUZZ_MEMBER_ADDED_NOTIFICATION_KIND } from "./room-membership-notification.js";

const { BOT_PUBLIC_KEY, CHANNEL_ID, RELAY_PUBLIC_KEY, startTestBus, subscriptionIncludesKind } =
  useBuzzBusLifecycleFixture();

function roomMetadata(params: { id: string; createdAt: number; archived: boolean }): Event {
  return {
    id: params.id,
    kind: 39_000,
    pubkey: RELAY_PUBLIC_KEY,
    created_at: params.createdAt,
    content: "",
    sig: "e".repeat(128),
    tags: [
      ["d", CHANNEL_ID],
      ["name", params.archived ? "Archived room" : "Active room"],
      ...(params.archived ? [["archived", "true"]] : []),
    ],
  };
}

describe("Buzz archived room lifecycle", () => {
  beforeEach(() => {
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.membershipEvents[0]!.tags = relayMocks.membershipEvents[0]!.tags.filter(
      (tag) => tag[0] !== "p" || tag[1] === BOT_PUBLIC_KEY,
    );
  });

  it("does not subscribe to configured rooms whose relay metadata marks them archived", async () => {
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-archived", createdAt: 1_700_000_000, archived: true }),
    ];

    const bus = await startTestBus();

    expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 9))).toBe(
      false,
    );
    expect(
      relayMocks.subscriptions.some((entry) =>
        subscriptionIncludesKind(entry, BUZZ_MEMBER_ADDED_NOTIFICATION_KIND),
      ),
    ).toBe(true);
    expect(bus.directory.activeRoomIds()).toEqual([]);
    expect(bus.directory.listGroups({})).toEqual([]);
    await bus.close();
  });

  it("keeps the bus connected when an active room becomes archived", async () => {
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-active", createdAt: 1_700_000_000, archived: false }),
    ];
    const onFatalError = vi.fn();
    const bus = await startTestBus({
      onFatalError,
    });
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-archived", createdAt: 1_700_000_001, archived: true }),
    ];

    relayMocks.subscriptions
      .find((entry) => subscriptionIncludesKind(entry, 9_002))
      ?.handlers.onevent({
        id: "archive-room",
        kind: 9_002,
        pubkey: "a".repeat(64),
        created_at: 1_700_000_001,
        content: "",
        sig: "e".repeat(128),
        tags: [["h", CHANNEL_ID]],
      });

    await vi.waitFor(() => expect(bus.directory.activeRoomIds()).toEqual([]));
    expect(onFatalError).not.toHaveBeenCalled();
    expect(relayMocks.close).not.toHaveBeenCalled();
    await bus.close();
  });

  it("subscribes in place when an initially archived room becomes active", async () => {
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-archived", createdAt: 1_700_000_000, archived: true }),
    ];
    const onFatalError = vi.fn();
    const bus = await startTestBus({
      onFatalError,
    });
    relayMocks.roomMetadataEvents = [
      roomMetadata({ id: "room-metadata-restored", createdAt: 1_700_000_001, archived: false }),
    ];
    const restoreNotification: Event = {
      id: "restore-room",
      kind: BUZZ_MEMBER_ADDED_NOTIFICATION_KIND,
      pubkey: RELAY_PUBLIC_KEY,
      created_at: 1_700_000_001,
      content: JSON.stringify({ type: "member_added", channel_id: CHANNEL_ID }),
      sig: "e".repeat(128),
      tags: [
        ["p", BOT_PUBLIC_KEY],
        ["h", CHANNEL_ID],
      ],
    };
    const notifications = relayMocks.subscriptions.find((entry) =>
      subscriptionIncludesKind(entry, BUZZ_MEMBER_ADDED_NOTIFICATION_KIND),
    );
    notifications?.handlers.onevent(restoreNotification);

    await vi.waitFor(() =>
      expect(relayMocks.subscriptions.some((entry) => subscriptionIncludesKind(entry, 9))).toBe(
        true,
      ),
    );
    notifications?.handlers.onevent(restoreNotification);
    expect(bus.directory.activeRoomIds()).toEqual([CHANNEL_ID]);
    expect(onFatalError).not.toHaveBeenCalled();
    expect(relayMocks.close).not.toHaveBeenCalled();
    await bus.close();
  });
});
