import type { Event } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  BuzzDirectoryState,
  BUZZ_PROFILE_KIND,
  BUZZ_ROOM_METADATA_KIND,
} from "./directory-state.js";
import type { BuzzRoomMembership } from "./room-membership.js";

const BOT_PUBLIC_KEY = "a".repeat(64);
const ALICE_PUBLIC_KEY = "b".repeat(64);
const BOB_PUBLIC_KEY = "c".repeat(64);
const ROOM_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";

function event(params: Partial<Event> & Pick<Event, "kind" | "pubkey">): Event {
  return {
    id: "f".repeat(64),
    created_at: 1_700_000_000,
    content: "",
    sig: "e".repeat(128),
    tags: [],
    ...params,
  };
}

function membership(members: string[]): BuzzRoomMembership {
  return {
    roomId: ROOM_ID,
    createdAt: 1_700_000_000,
    eventId: "1".repeat(64),
    publisherPublicKey: "d".repeat(64),
    members: new Set(members),
    roles: new Map(),
  };
}

function profileState(
  members: string[] = [BOT_PUBLIC_KEY, ALICE_PUBLIC_KEY],
  profileLimit?: number,
): BuzzDirectoryState {
  const state = new BuzzDirectoryState({
    publicKey: BOT_PUBLIC_KEY,
    fallbackProfileName: "OpenClaw",
    channelIds: [ROOM_ID],
    profileLimit,
  });
  state.replaceMemberships(new Map([[ROOM_ID, membership(members)]]));
  return state;
}

function profile(content: Record<string, string> | string, overrides: Partial<Event> = {}) {
  return event({
    kind: BUZZ_PROFILE_KIND,
    pubkey: ALICE_PUBLIC_KEY,
    content: typeof content === "string" ? content : JSON.stringify(content),
    ...overrides,
  });
}

function room(name: string, archived?: boolean, overrides: Partial<Event> = {}) {
  return event({
    kind: BUZZ_ROOM_METADATA_KIND,
    pubkey: "d".repeat(64),
    tags: [
      ["d", ROOM_ID],
      ["name", name],
      ...(archived === undefined ? [] : [["archived", String(archived)]]),
    ],
    ...overrides,
  });
}

describe("Buzz directory state", () => {
  it("parses Buzz profile precedence without trusting malformed content", () => {
    const preferred = profileState();
    expect(
      preferred.applyProfileEvent(
        profile({
          display_name: "Alice",
          name: "ignored",
          picture: "https://example.com/alice.png",
          image: "https://example.com/ignored.png",
          nip05: "alice@example.com",
        }),
      ),
    ).toBe(true);
    expect(preferred.listPeers({})).toMatchObject([
      {
        id: ALICE_PUBLIC_KEY,
        name: "Alice",
        handle: "alice@example.com",
        avatarUrl: "https://example.com/alice.png",
      },
    ]);

    const fallback = profileState();
    fallback.applyProfileEvent(
      profile({ name: "Fallback", image: "https://example.com/fallback.png" }),
    );
    expect(fallback.listPeers({})).toMatchObject([
      {
        name: "Fallback",
        avatarUrl: "https://example.com/fallback.png",
      },
    ]);

    const emptyPrimary = profileState();
    emptyPrimary.applyProfileEvent(profile({ display_name: "", name: "not-used" }));
    expect(emptyPrimary.listPeers({})[0]?.name).toBe("bbbbbbbb...bbbbbb");

    expect(profileState().applyProfileEvent(profile("{"))).toBe(false);
  });

  it("keeps stable public-key ids while applying current profiles and room metadata", () => {
    const state = profileState([BOT_PUBLIC_KEY, ALICE_PUBLIC_KEY, BOB_PUBLIC_KEY]);
    state.applyProfileEvent(
      profile({ display_name: "Alice", picture: "https://example.com/alice.png" }),
    );
    state.applyRoomEvent(room("Engineering"));

    expect(state.resolveSenderName(ALICE_PUBLIC_KEY)).toBe("Alice");
    expect(state.resolveSenderName(BOB_PUBLIC_KEY)).toBe("cccccccc...cccccc");
    expect(state.listPeers({ query: "ali" })).toMatchObject([
      {
        kind: "user",
        id: ALICE_PUBLIC_KEY,
        name: "Alice",
        avatarUrl: "https://example.com/alice.png",
      },
    ]);
    expect(state.listGroups({})).toMatchObject([
      {
        kind: "group",
        id: `buzz:${ROOM_ID}`,
        name: "Engineering",
      },
    ]);
    expect(
      state.listGroupMembers({ groupId: `buzz:${ROOM_ID}`, limit: 2 }).map((entry) => entry.id),
    ).toEqual([ALICE_PUBLIC_KEY, BOB_PUBLIC_KEY]);
  });

  it("excludes rooms whose latest relay metadata marks them archived", () => {
    const state = profileState();
    state.applyRoomEvent(room("Archived room", true, { id: "2".repeat(64) }));

    expect(state.activeRoomIds()).toEqual([]);
    expect(state.isRoomArchived(ROOM_ID)).toBe(true);
    expect(state.listPeers({})).toEqual([]);
    expect(state.listGroups({})).toEqual([]);
    expect(state.listGroupMembers({ groupId: ROOM_ID })).toEqual([]);

    state.applyRoomEvent(
      room("Restored room", false, { id: "1".repeat(64), created_at: 1_700_000_001 }),
    );

    expect(state.activeRoomIds()).toEqual([ROOM_ID]);
    expect(state.isRoomArchived(ROOM_ID)).toBe(false);
    expect(state.listPeers({})).not.toEqual([]);
    expect(state.listGroups({})).toMatchObject([{ id: `buzz:${ROOM_ID}`, name: "Restored room" }]);
  });

  it("uses deterministic latest-event ordering and bounded profile selection", () => {
    const state = profileState([BOT_PUBLIC_KEY, BOB_PUBLIC_KEY, ALICE_PUBLIC_KEY], 2);

    expect(state.profilePublicKeys()).toEqual([BOT_PUBLIC_KEY, ALICE_PUBLIC_KEY]);
    expect(
      state.applyProfileEvent(profile({ display_name: "First" }, { id: "2".repeat(64) })),
    ).toBe(true);
    expect(
      state.applyProfileEvent(profile({ display_name: "Older tie" }, { id: "3".repeat(64) })),
    ).toBe(false);
    expect(
      state.applyProfileEvent(profile({ display_name: "Winning tie" }, { id: "1".repeat(64) })),
    ).toBe(true);
    expect(
      state.applyProfileEvent(profile({ display_name: "Outside cap" }, { pubkey: BOB_PUBLIC_KEY })),
    ).toBe(false);
    expect(state.resolveSenderName(ALICE_PUBLIC_KEY)).toBe("Winning tie");
    expect(state.resolveSenderName(BOB_PUBLIC_KEY)).toBe("cccccccc...cccccc");
  });

  it("keeps stable fallback identities when the relay budget leaves no profile slots", () => {
    const state = profileState(undefined, 0);

    expect(state.profilePublicKeys()).toEqual([]);
    expect(state.self()).toMatchObject({ id: BOT_PUBLIC_KEY, name: "OpenClaw" });
    expect(state.listPeers({})).toMatchObject([
      { id: ALICE_PUBLIC_KEY, name: "bbbbbbbb...bbbbbb" },
    ]);
  });
});
