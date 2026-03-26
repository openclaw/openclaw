import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { createDirectRoomTracker } from "./direct.js";

function createMockClient(params: { isDm?: boolean; members?: string[] }) {
  let members = params.members ?? ["@alice:example.org", "@bot:example.org"];
  return {
    dms: {
      update: vi.fn().mockResolvedValue(undefined),
      isDm: vi.fn().mockReturnValue(params.isDm === true),
    },
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    getJoinedRoomMembers: vi.fn().mockImplementation(async () => members),
    __setMembers(next: string[]) {
      members = next;
    },
  } as unknown as MatrixClient & {
    dms: {
      update: ReturnType<typeof vi.fn>;
      isDm: ReturnType<typeof vi.fn>;
    };
    getJoinedRoomMembers: ReturnType<typeof vi.fn>;
    __setMembers: (members: string[]) => void;
  };
}

describe("createDirectRoomTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats m.direct rooms as DMs", async () => {
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not trust stale m.direct classifications for shared rooms", async () => {
    const client = createMockClient({
      isDm: true,
      members: ["@alice:example.org", "@bot:example.org", "@extra:example.org"],
    });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not classify 2-member rooms as DMs when the dm cache refresh succeeds", async () => {
    const client = createMockClient({ isDm: false });
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("falls back to strict 2-member membership when dm cache refresh fails", async () => {
    const client = createMockClient({ isDm: false });
    client.dms.update.mockRejectedValue(new Error("dm cache unavailable"));
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    expect(client.getJoinedRoomMembers).toHaveBeenCalledWith("!room:example.org");
  });

  it("does not classify rooms with extra members as DMs when falling back", async () => {
    const client = createMockClient({
      isDm: false,
      members: ["@alice:example.org", "@bot:example.org", "@observer:example.org"],
    });
    client.dms.update.mockRejectedValue(new Error("dm cache unavailable"));
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("does not classify 2-member rooms whose sender is not a joined member when falling back", async () => {
    const client = createMockClient({
      isDm: false,
      members: ["@mallory:example.org", "@bot:example.org"],
    });
    client.dms.update.mockRejectedValue(new Error("dm cache unavailable"));
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("re-checks room membership after invalidation when fallback membership changes", async () => {
    const client = createMockClient({ isDm: false });
    client.dms.update.mockRejectedValue(new Error("dm cache unavailable"));
    const tracker = createDirectRoomTracker(client);

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(true);

    client.__setMembers(["@alice:example.org", "@bot:example.org", "@mallory:example.org"]);
    tracker.invalidateRoom("!room:example.org");

    await expect(
      tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      }),
    ).resolves.toBe(false);
  });

  it("bounds joined-room membership cache size", async () => {
    const client = createMockClient({ isDm: false });
    client.dms.update.mockRejectedValue(new Error("dm cache unavailable"));
    const tracker = createDirectRoomTracker(client);

    for (let i = 0; i <= 1024; i += 1) {
      await tracker.isDirectMessage({
        roomId: `!room-${i}:example.org`,
        senderId: "@alice:example.org",
      });
    }

    await tracker.isDirectMessage({
      roomId: "!room-0:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1026);
  });

  it("refreshes dm and membership caches after the ttl expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
    const client = createMockClient({ isDm: true });
    const tracker = createDirectRoomTracker(client);

    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });
    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.dms.update).toHaveBeenCalledTimes(1);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-12T10:00:31Z"));

    await tracker.isDirectMessage({
      roomId: "!room:example.org",
      senderId: "@alice:example.org",
    });

    expect(client.dms.update).toHaveBeenCalledTimes(2);
    expect(client.getJoinedRoomMembers).toHaveBeenCalledTimes(2);
  });
});
