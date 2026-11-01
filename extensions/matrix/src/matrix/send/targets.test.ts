import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { EventType } from "./types.js";

const { resolveMatrixRoomId, normalizeThreadId } = await import("./targets.js");

const BOT_USER_ID = "@bot:example.org";
const userId = "@fallback:example.org";
const roomId = "!room:example.org";

const makeDirectClient = ({
  roomIds = [],
  mappedRoomIds,
  botId = BOT_USER_ID,
  members = [botId, userId],
  ...overrides
}: {
  roomIds?: string[];
  mappedRoomIds?: string[];
  botId?: string;
  members?: string[];
} & Partial<MatrixClient>) =>
  ({
    getAccountData: vi.fn(async () => (mappedRoomIds ? { [userId]: mappedRoomIds } : undefined)),
    getUserId: vi.fn().mockResolvedValue(botId),
    getJoinedRooms: vi.fn().mockResolvedValue(roomIds),
    getJoinedRoomMembers: vi.fn().mockResolvedValue(members),
    setAccountData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as MatrixClient;

const directFlag = (markedRoom: string, markedUser: string) =>
  vi.fn(async (room: string, _eventType: string, stateKey = "") =>
    room === markedRoom && stateKey === markedUser ? { is_direct: true } : {},
  );

describe("resolveMatrixRoomId", () => {
  it.each(["@fallback:example.org", "user:@fallback:example.org"])(
    "preserves send mapping repair after cached read resolution of %s",
    async (target) => {
      const client = makeDirectClient({ roomIds: [roomId] });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          resolveMatrixRoomId(client, target, { persistDirectMapping: false }),
        ).resolves.toBe(roomId);
      }
      expect(client["getJoinedRooms"]).toHaveBeenCalledTimes(1);
      expect(client["setAccountData"]).not.toHaveBeenCalled();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(resolveMatrixRoomId(client, target)).resolves.toBe(roomId);
      }
      expect(client["getJoinedRooms"]).toHaveBeenCalledTimes(2);
      expect(client["setAccountData"]).toHaveBeenCalledExactlyOnceWith(EventType.Direct, {
        [userId]: [roomId],
      });
    },
  );

  it.each([
    [BOT_USER_ID, "!marked:example.org"],
    [userId, roomId],
  ])("only prefers direct flags from local member state (%s)", async (markedUser, expected) => {
    const client = makeDirectClient({
      roomIds: [roomId, "!marked:example.org"],
      getRoomStateEvent: directFlag("!marked:example.org", markedUser),
    });
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(expected);
    expect(client["setAccountData"]).toHaveBeenCalledWith(EventType.Direct, {
      [userId]: [expected],
    });
  });

  it("continues when a room member lookup fails", async () => {
    const client = makeDirectClient({
      roomIds: ["!bad:example.org", roomId],
      getJoinedRoomMembers: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce([BOT_USER_ID, userId]),
    });
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(roomId);
    expect(client["setAccountData"]).toHaveBeenCalled();
  });

  it("does not fall back to larger shared rooms for direct-user sends", async () => {
    const client = makeDirectClient({
      roomIds: [roomId],
      members: [BOT_USER_ID, userId, "@extra:example.org"],
    });
    await expect(resolveMatrixRoomId(client, userId)).rejects.toThrow(
      `No direct room found for ${userId} (m.direct missing)`,
    );
    expect(client["setAccountData"]).not.toHaveBeenCalled();
  });

  it("accepts nested Matrix user target prefixes", async () => {
    const client = makeDirectClient({ mappedRoomIds: [roomId], resolveRoom: vi.fn() });
    await expect(resolveMatrixRoomId(client, `matrix:user:${userId}`)).resolves.toBe(roomId);
    expect(client["resolveRoom"]).not.toHaveBeenCalled();
    expect(client["getJoinedRooms"]).toHaveBeenCalledTimes(1);
    expect(client["setAccountData"]).not.toHaveBeenCalled();
  });

  it("scopes direct-room cache per Matrix client", async () => {
    for (const suffix of ["a", "b"]) {
      const mappedRoom = `!room-${suffix}:example.org`;
      const client = makeDirectClient({
        botId: `@bot-${suffix}:example.org`,
        mappedRoomIds: [mappedRoom],
      });
      await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(mappedRoom);
      expect(client["getAccountData"]).toHaveBeenCalledTimes(1);
    }
  });

  it.each([false, true])(
    "evicts the oldest direct room despite a cache hit with persistDirectMapping=%s",
    async (persistDirectMapping) => {
      const directRooms = Object.fromEntries(
        Array.from({ length: 1025 }, (_, index) => [
          `@user-${index}:example.org`,
          [`!room-${index}:example.org`],
        ]),
      );
      const membersByRoom = new Map(
        Object.entries(directRooms).map(([user, [room]]) => [room, [BOT_USER_ID, user]]),
      );
      const getAccountData = vi.fn<MatrixClient["getAccountData"]>().mockResolvedValue(directRooms);
      const getJoinedRooms = vi.fn<MatrixClient["getJoinedRooms"]>().mockResolvedValue([]);
      const getJoinedRoomMembers = vi.fn(async (room: string) => membersByRoom.get(room) ?? []);
      const client = makeDirectClient({ getAccountData, getJoinedRooms, getJoinedRoomMembers });
      const lookupCounts = () =>
        [getAccountData, getJoinedRooms].map((mock) => mock.mock.calls.length);
      const resolve = (index: number) =>
        resolveMatrixRoomId(client, `@user-${index}:example.org`, { persistDirectMapping });

      for (let index = 0; index < 1024; index += 1) {
        await expect(resolve(index)).resolves.toBe(`!room-${index}:example.org`);
      }
      await expect(resolve(0)).resolves.toBe("!room-0:example.org");
      expect(lookupCounts()).toEqual([1024, 1024]);

      await expect(resolve(1024)).resolves.toBe("!room-1024:example.org");
      // Check the survivor before refetching the victim causes another eviction.
      await expect(resolve(1)).resolves.toBe("!room-1:example.org");
      expect(lookupCounts()).toEqual([1025, 1025]);
      await expect(resolve(0)).resolves.toBe("!room-0:example.org");
      expect(lookupCounts()).toEqual([1026, 1026]);
      expect(client["setAccountData"]).not.toHaveBeenCalled();
    },
  );

  it.each(["getAccountData", "setAccountData"])("survives %s failure", async (method) => {
    const client = makeDirectClient({
      roomIds: [roomId],
      [method]: vi.fn().mockRejectedValue(new Error("account data unavailable")),
    });
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(roomId);
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(roomId);
    expect(client["getJoinedRooms"]).toHaveBeenCalledTimes(1);
    if (method === "getAccountData") {
      expect(client["setAccountData"]).not.toHaveBeenCalled();
    } else {
      expect(client["setAccountData"]).toHaveBeenCalledExactlyOnceWith(EventType.Direct, {
        [userId]: [roomId],
      });
    }
  });

  it("ignores m.direct entries that point at shared rooms", async () => {
    const client = makeDirectClient({
      mappedRoomIds: ["!shared-room:example.org", "!dm-room:example.org"],
      getJoinedRoomMembers: vi
        .fn()
        .mockResolvedValueOnce([BOT_USER_ID, userId, "@extra:example.org"])
        .mockResolvedValueOnce([BOT_USER_ID, userId]),
    });
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe("!dm-room:example.org");
  });

  it("revalidates cached direct rooms before reuse when membership changes", async () => {
    const directRooms = ["!dm-room-1:example.org"];
    const membersByRoom = new Map<string, string[]>([
      ["!dm-room-1:example.org", ["@bot:example.org", userId]],
      ["!dm-room-2:example.org", ["@bot:example.org", userId]],
    ]);
    const client = makeDirectClient({
      roomIds: ["!dm-room-1:example.org", "!dm-room-2:example.org"],
      getAccountData: vi.fn(async () => ({ [userId]: [...directRooms] })),
      getJoinedRoomMembers: vi.fn(async (room: string) => membersByRoom.get(room) ?? []),
    });
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe("!dm-room-1:example.org");

    directRooms.splice(0, directRooms.length, "!dm-room-1:example.org", "!dm-room-2:example.org");
    membersByRoom.set("!dm-room-1:example.org", [BOT_USER_ID, userId, "@mallory:example.org"]);

    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe("!dm-room-2:example.org");
  });
});

it("normalizeThreadId returns null for empty thread ids", () => {
  expect(normalizeThreadId("   ")).toBeNull();
  expect(normalizeThreadId("$thread")).toBe("$thread");
});
