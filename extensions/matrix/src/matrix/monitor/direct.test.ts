import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { EventType } from "../send/types.js";
import { createDirectRoomTracker } from "./direct.js";

type MockStateEvents = Record<string, Record<string, unknown>>;

const DEFAULT_DIRECT_CHECK = {
  roomId: "!room:example.org",
  senderId: "@alice:example.org",
  selfUserId: "@bot:example.org",
};

function checkDefaultRoom(tracker: ReturnType<typeof createDirectRoomTracker>) {
  return tracker.isDirectMessage(DEFAULT_DIRECT_CHECK);
}

function createMockClient(params: {
  isDm?: boolean;
  members?: string[];
  stateEvents?: MockStateEvents;
  dmCacheAvailable?: boolean;
  directAccountData?: Record<string, string[]>;
  setAccountDataError?: Error;
}) {
  const members = params.members ?? ["@alice:example.org", "@bot:example.org"];
  const stateEvents = params.stateEvents ?? {};
  let directAccountData = params.directAccountData ?? {};
  const dmRoomIds = new Set<string>();
  if (params.isDm === true) {
    dmRoomIds.add("!room:example.org");
  }
  return {
    dms: {
      update: vi.fn().mockResolvedValue(params.dmCacheAvailable !== false),
      isDm: vi.fn((roomId: string) => dmRoomIds.has(roomId)),
    },
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    getAccountData: vi.fn(async (eventType: string) =>
      eventType === EventType.Direct ? directAccountData : undefined,
    ),
    getJoinedRoomMembers: vi.fn(async () => members),
    getRoomStateEvent: vi.fn(async (roomId: string, eventType: string, stateKey = "") => {
      const key = `${roomId}|${eventType}|${stateKey}`;
      const state = stateEvents[key];
      if (state === undefined) {
        throw new Error(`State event not found: ${key}`);
      }
      return state;
    }),
    setAccountData: vi.fn(async (eventType: string, content: unknown) => {
      if (params.setAccountDataError) {
        throw params.setAccountDataError;
      }
      if (eventType !== EventType.Direct) {
        return;
      }
      directAccountData = (content as Record<string, string[]>) ?? {};
      dmRoomIds.clear();
      for (const value of Object.values(directAccountData)) {
        if (!Array.isArray(value)) {
          continue;
        }
        for (const roomId of value) {
          if (typeof roomId === "string" && roomId.trim()) {
            dmRoomIds.add(roomId);
          }
        }
      }
    }),
  };
}

function setup(
  params: Parameters<typeof createMockClient>[0] = {},
  options?: Parameters<typeof createDirectRoomTracker>[1],
) {
  const client = createMockClient(params);
  return { client, tracker: createDirectRoomTracker(client as unknown as MatrixClient, options) };
}

describe("createDirectRoomTracker", () => {
  afterEach(() => vi.useRealTimers());

  it("lets explicit room config veto stale m.direct classifications", async () => {
    const { client, tracker } = setup(
      { isDm: true },
      { isExplicitlyConfiguredRoom: (roomId) => roomId === "!room:example.org" },
    );
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
    expect(client.dms.update).not.toHaveBeenCalled();
    expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
  });

  it("does not trust stale m.direct classifications for shared rooms", async () => {
    const { client, tracker } = setup({
      isDm: true,
      members: ["@alice:example.org", "@bot:example.org", "@extra:example.org"],
    });
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("promotes strict unmapped rooms when the per-room fallback gate allows it", async () => {
    const { client, tracker } = setup({}, { canPromoteUnmappedStrictRoom: () => true });
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    expect(client.setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      "@alice:example.org": ["!room:example.org"],
    });
  });

  it("does not promote strict unmapped rooms when the per-room fallback gate vetoes it", async () => {
    const { client, tracker } = setup({}, { canPromoteUnmappedStrictRoom: () => false });
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("keeps using the strict 2-member fallback until the dm cache seeds successfully", async () => {
    const { client, tracker } = setup({ isDm: false, dmCacheAvailable: false });
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    expect(client.dms.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["@alice:example.org", true, false, false],
    ["@bot:example.org", true, false, true],
    ["@bot:example.org", false, true, false],
  ] as const)(
    "uses only authoritative self member flags: %s direct=%s invite=%s",
    async (user, direct, invite, expected) => {
      const { tracker } = setup({
        stateEvents: { [`!room:example.org|m.room.member|${user}`]: { is_direct: direct } },
      });
      if (invite) {
        tracker.rememberInvite("!room:example.org", "@alice:example.org");
      }
      await expect(checkDefaultRoom(tracker)).resolves.toBe(expected);
    },
  );

  it("does not promote recent invite candidates when local vetoes mark the room as non-DM", async () => {
    const { client, tracker } = setup({}, { canPromoteRecentInvite: () => false });
    tracker.rememberInvite("!room:example.org", "@alice:example.org");
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("keeps locally promoted direct rooms stable after repair failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T23:00:00Z"));
    const { tracker } = setup({ setAccountDataError: new Error("account data unavailable") });
    tracker.rememberInvite("!room:example.org", "@alice:example.org");
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    tracker.invalidateRoom("!room:example.org");

    vi.setSystemTime(new Date("2026-03-30T23:01:00Z"));
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
  });

  it("drops locally promoted direct rooms when room metadata later vetoes promotion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T23:00:00Z"));
    let keepLocalPromotion = true;
    const { tracker } = setup(
      { setAccountDataError: new Error("account data unavailable") },
      {
        canPromoteRecentInvite: () => true,
        shouldKeepLocallyPromotedDirectRoom: () => keepLocalPromotion,
      },
    );
    tracker.rememberInvite("!room:example.org", "@alice:example.org");
    await expect(checkDefaultRoom(tracker)).resolves.toBe(true);
    keepLocalPromotion = false;
    vi.setSystemTime(new Date("2026-03-30T23:01:00Z"));
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("does not classify 2-member rooms whose sender is not a joined member when falling back", async () => {
    const { tracker } = setup({
      members: ["@mallory:example.org", "@bot:example.org"],
      dmCacheAvailable: false,
    });
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });

  it("does not re-enable the strict 2-member fallback after the dm cache has seeded", async () => {
    const { client, tracker } = setup({});
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
    client.dms.update.mockResolvedValue(false);
    tracker.invalidateRoom("!room:example.org");
    await expect(checkDefaultRoom(tracker)).resolves.toBe(false);
  });
});
