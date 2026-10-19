import { describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { EventType } from "./types.js";

const { resolveMatrixRoomId, normalizeThreadId } = await import("./targets.js");

const BOT_USER_ID = "@bot:example.org";
const userId = "@fallback:example.org";
const roomId = "!room:example.org";

const makeDirectClient = (params: {
  userId: string;
  roomIds?: string[];
  mappedRoomIds?: string[];
  botId?: string;
  members?: string[];
  extra?: Record<string, unknown>;
}) =>
  ({
    getAccountData: vi
      .fn()
      .mockResolvedValue(
        params.mappedRoomIds ? { [params.userId]: params.mappedRoomIds } : undefined,
      ),
    getUserId: vi.fn().mockResolvedValue(params.botId ?? BOT_USER_ID),
    getJoinedRooms: vi.fn().mockResolvedValue(params.roomIds ?? []),
    getJoinedRoomMembers: vi
      .fn()
      .mockResolvedValue(params.members ?? [params.botId ?? BOT_USER_ID, params.userId]),
    setAccountData: vi.fn().mockResolvedValue(undefined),
    ...params.extra,
  }) as unknown as MatrixClient;

const directFlag = (markedRoom: string, markedUser: string) =>
  vi
    .fn()
    .mockImplementation(async (room: string, _eventType: string, stateKey: string) =>
      room === markedRoom && stateKey === markedUser ? { is_direct: true } : {},
    );

describe("resolveMatrixRoomId", () => {
  it.each(["@fallback:example.org", "user:@fallback:example.org"])(
    "preserves send mapping repair after cached read resolution of %s",
    async (target) => {
      const client = makeDirectClient({ userId, roomIds: [roomId] });

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

  it("prefers joined rooms marked direct in local member state over plain strict rooms", async () => {
    const client = makeDirectClient({
      userId,
      roomIds: ["!fallback:example.org", "!explicit:example.org"],
      extra: { getRoomStateEvent: directFlag("!explicit:example.org", BOT_USER_ID) },
    });

    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe("!explicit:example.org");
    expect(client["setAccountData"]).toHaveBeenCalledWith(EventType.Direct, {
      [userId]: ["!explicit:example.org"],
    });
  });

  it("ignores remote member-state direct flags when resolving a direct room", async () => {
    const client = makeDirectClient({
      userId,
      roomIds: ["!fallback:example.org", "!remote-marked:example.org"],
      extra: { getRoomStateEvent: directFlag("!remote-marked:example.org", userId) },
    });

    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe("!fallback:example.org");
    expect(client["setAccountData"]).toHaveBeenCalledWith(EventType.Direct, {
      [userId]: ["!fallback:example.org"],
    });
  });

  it("continues when a room member lookup fails", async () => {
    const client = makeDirectClient({
      userId,
      roomIds: ["!bad:example.org", roomId],
      extra: {
        getJoinedRoomMembers: vi
          .fn()
          .mockRejectedValueOnce(new Error("boom"))
          .mockResolvedValueOnce([BOT_USER_ID, userId]),
      },
    });
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(roomId);
    expect(client["setAccountData"]).toHaveBeenCalled();
  });

  it("does not fall back to larger shared rooms for direct-user sends", async () => {
    const client = makeDirectClient({
      userId,
      roomIds: [roomId],
      members: [BOT_USER_ID, userId, "@extra:example.org"],
    });

    await expect(resolveMatrixRoomId(client, userId)).rejects.toThrow(
      `No direct room found for ${userId} (m.direct missing)`,
    );
    expect(client["setAccountData"]).not.toHaveBeenCalled();
  });

  it("accepts nested Matrix user target prefixes", async () => {
    const client = makeDirectClient({
      userId,
      mappedRoomIds: [roomId],
      extra: { resolveRoom: vi.fn() },
    });

    await expect(resolveMatrixRoomId(client, `matrix:user:${userId}`)).resolves.toBe(roomId);
    expect(client["resolveRoom"]).not.toHaveBeenCalled();
    expect(client["getJoinedRooms"]).toHaveBeenCalledTimes(1);
    expect(client["setAccountData"]).not.toHaveBeenCalled();
  });

  it("scopes direct-room cache per Matrix client", async () => {
    const clientA = makeDirectClient({
      userId,
      botId: "@bot-a:example.org",
      mappedRoomIds: ["!room-a:example.org"],
    });
    const clientB = makeDirectClient({
      userId,
      botId: "@bot-b:example.org",
      mappedRoomIds: ["!room-b:example.org"],
    });

    await expect(resolveMatrixRoomId(clientA, userId)).resolves.toBe("!room-a:example.org");
    await expect(resolveMatrixRoomId(clientB, userId)).resolves.toBe("!room-b:example.org");

    expect(clientA["getAccountData"]).toHaveBeenCalledTimes(1);
    expect(clientB["getAccountData"]).toHaveBeenCalledTimes(1);
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
        Array.from({ length: 1025 }, (_, index): [string, string[]] => [
          `!room-${index}:example.org`,
          [BOT_USER_ID, `@user-${index}:example.org`],
        ]),
      );
      const getAccountData = vi.fn<MatrixClient["getAccountData"]>().mockResolvedValue(directRooms);
      const getJoinedRooms = vi.fn<MatrixClient["getJoinedRooms"]>().mockResolvedValue([]);
      const getJoinedRoomMembers = vi
        .fn<MatrixClient["getJoinedRoomMembers"]>()
        .mockImplementation(async (room) => membersByRoom.get(room) ?? []);
      const client = makeDirectClient({
        userId: "@user-0:example.org",
        extra: { getAccountData, getJoinedRooms, getJoinedRoomMembers },
      });
      const resolve = (index: number) =>
        resolveMatrixRoomId(client, `@user-${index}:example.org`, { persistDirectMapping });

      for (let index = 0; index < 1024; index += 1) {
        await expect(resolve(index)).resolves.toBe(`!room-${index}:example.org`);
      }
      await expect(resolve(0)).resolves.toBe("!room-0:example.org");
      expect(getAccountData).toHaveBeenCalledTimes(1024);
      expect(getJoinedRooms).toHaveBeenCalledTimes(1024);

      await expect(resolve(1024)).resolves.toBe("!room-1024:example.org");
      // Check the survivor before refetching the victim causes another eviction.
      await expect(resolve(1)).resolves.toBe("!room-1:example.org");
      expect(getAccountData).toHaveBeenCalledTimes(1025);
      expect(getJoinedRooms).toHaveBeenCalledTimes(1025);
      await expect(resolve(0)).resolves.toBe("!room-0:example.org");
      expect(getAccountData).toHaveBeenCalledTimes(1026);
      expect(getJoinedRooms).toHaveBeenCalledTimes(1026);
      expect(client["setAccountData"]).not.toHaveBeenCalled();
    },
  );

  it("keeps a usable direct room when account-data reads fail", async () => {
    const client = makeDirectClient({
      userId,
      roomIds: [roomId],
      extra: {
        getAccountData: vi.fn().mockRejectedValue(new Error("account data unavailable")),
      },
    });

    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(roomId);
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(roomId);
    expect(client["getJoinedRooms"]).toHaveBeenCalledTimes(1);
    expect(client["setAccountData"]).not.toHaveBeenCalled();
  });

  it("caches a usable direct room after an ordinary mapping write failure", async () => {
    const client = makeDirectClient({
      userId,
      roomIds: [roomId],
      extra: { setAccountData: vi.fn().mockRejectedValue(new Error("mapping write failed")) },
    });

    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(roomId);
    await expect(resolveMatrixRoomId(client, userId)).resolves.toBe(roomId);

    expect(client["getJoinedRooms"]).toHaveBeenCalledTimes(1);
    expect(client["setAccountData"]).toHaveBeenCalledExactlyOnceWith(EventType.Direct, {
      [userId]: [roomId],
    });
  });

  it("ignores m.direct entries that point at shared rooms", async () => {
    const client = makeDirectClient({
      userId,
      mappedRoomIds: ["!shared-room:example.org", "!dm-room:example.org"],
      extra: {
        getJoinedRoomMembers: vi
          .fn()
          .mockResolvedValueOnce([BOT_USER_ID, userId, "@extra:example.org"])
          .mockResolvedValueOnce([BOT_USER_ID, userId]),
      },
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
      userId,
      roomIds: ["!dm-room-1:example.org", "!dm-room-2:example.org"],
      extra: {
        getAccountData: vi.fn().mockImplementation(async () => ({ [userId]: [...directRooms] })),
        getJoinedRoomMembers: vi
          .fn()
          .mockImplementation(async (room: string) => membersByRoom.get(room) ?? []),
      },
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
