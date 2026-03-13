import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventType } from "./types.js";

let resolveMatrixRoomId: typeof import("./targets.js").resolveMatrixRoomId;
let normalizeThreadId: typeof import("./targets.js").normalizeThreadId;

beforeEach(async () => {
  vi.resetModules();
  ({ resolveMatrixRoomId, normalizeThreadId } = await import("./targets.js"));
});

function createMockClient(opts: {
  selfUserId?: string;
  directContent?: Record<string, string[] | undefined>;
  joinedRooms?: string[];
  membersByRoom?: Record<string, string[]>;
  dmRooms?: Record<string, boolean>;
  roomStateEvents?: Record<string, Record<string, unknown>>;
  getAccountDataError?: Error;
  getJoinedRoomsError?: Error;
  getJoinedRoomMembers?: ReturnType<typeof vi.fn>;
}) {
  const getRoomStateEvent = vi
    .fn()
    .mockImplementation(async (roomId: string, eventType: string, stateKey: string) => {
      const key = `${roomId}|${eventType}|${stateKey}`;
      const event = opts.roomStateEvents?.[key];
      if (event === undefined) {
        const err = new Error(`missing state ${key}`) as Error & {
          errcode?: string;
          statusCode?: number;
        };
        err.errcode = "M_NOT_FOUND";
        err.statusCode = 404;
        throw err;
      }
      return event;
    });

  return {
    getUserId: vi.fn().mockResolvedValue(opts.selfUserId ?? "@bot:example.org"),
    getAccountData: opts.getAccountDataError
      ? vi.fn().mockRejectedValue(opts.getAccountDataError)
      : vi.fn().mockResolvedValue(opts.directContent ?? {}),
    getJoinedRooms: opts.getJoinedRoomsError
      ? vi.fn().mockRejectedValue(opts.getJoinedRoomsError)
      : vi.fn().mockResolvedValue(opts.joinedRooms ?? []),
    getJoinedRoomMembers:
      opts.getJoinedRoomMembers ??
      vi.fn().mockImplementation(async (roomId: string) => opts.membersByRoom?.[roomId] ?? []),
    getRoomStateEvent,
    setAccountData: vi.fn().mockResolvedValue(undefined),
    dms: {
      update: vi.fn().mockResolvedValue(undefined),
      isDm: vi.fn().mockImplementation((roomId: string) => opts.dmRooms?.[roomId] ?? false),
    },
  } as unknown as MatrixClient;
}

describe("resolveMatrixRoomId", () => {
  it("uses m.direct when available", async () => {
    const userId = "@user:example.org";
    const client = createMockClient({
      directContent: {
        [userId]: ["!room:example.org"],
      },
      getJoinedRoomsError: new Error("offline"),
    });

    const roomId = await resolveMatrixRoomId(client, userId);

    expect(roomId).toBe("!room:example.org");
    // oxlint-disable-next-line typescript/unbound-method
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("prefers the strongest DM candidate over stale m.direct ordering", async () => {
    const userId = "@user:example.org";
    const staleRoom = "!stale:example.org";
    const activeRoom = "!active:example.org";
    const client = createMockClient({
      directContent: {
        [userId]: [staleRoom, activeRoom],
      },
      joinedRooms: [staleRoom, activeRoom],
      membersByRoom: {
        [staleRoom]: ["@bot:example.org", userId],
        [activeRoom]: ["@bot:example.org", userId],
      },
      dmRooms: {
        [activeRoom]: true,
      },
      roomStateEvents: {
        [`${staleRoom}|m.room.member|${userId}`]: {},
        [`${staleRoom}|m.room.member|@bot:example.org`]: {},
        [`${staleRoom}|m.room.name|`]: { name: "Old named room" },
        [`${activeRoom}|m.room.member|${userId}`]: { is_direct: true },
        [`${activeRoom}|m.room.member|@bot:example.org`]: { is_direct: true },
      },
    });

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe(activeRoom);
    expect(client.setAccountData).toHaveBeenCalledWith(
      EventType.Direct,
      expect.objectContaining({ [userId]: [activeRoom, staleRoom] }),
    );
  });

  it("falls back to joined rooms and persists m.direct", async () => {
    const userId = "@fallback:example.org";
    const roomId = "!room:example.org";
    const client = createMockClient({
      getAccountDataError: new Error("nope"),
      joinedRooms: [roomId],
      membersByRoom: {
        [roomId]: ["@bot:example.org", userId],
      },
      roomStateEvents: {
        [`${roomId}|m.room.member|${userId}`]: { is_direct: true },
        [`${roomId}|m.room.member|@bot:example.org`]: {},
      },
    });

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe(roomId);
    expect(client.setAccountData).toHaveBeenCalledWith(
      EventType.Direct,
      expect.objectContaining({ [userId]: [roomId] }),
    );
  });

  it("continues when a room member lookup fails", async () => {
    const userId = "@continue:example.org";
    const roomId = "!good:example.org";
    const getJoinedRoomMembers = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(["@bot:example.org", userId]);
    const client = createMockClient({
      getAccountDataError: new Error("nope"),
      joinedRooms: ["!bad:example.org", roomId],
      getJoinedRoomMembers,
      roomStateEvents: {
        [`${roomId}|m.room.member|${userId}`]: { is_direct: true },
        [`${roomId}|m.room.member|@bot:example.org`]: {},
      },
    });

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe(roomId);
    expect(client.setAccountData).toHaveBeenCalled();
  });

  it("allows larger rooms when no 1:1 match exists", async () => {
    const userId = "@group:example.org";
    const roomId = "!group:example.org";
    const client = createMockClient({
      getAccountDataError: new Error("nope"),
      joinedRooms: [roomId],
      membersByRoom: {
        [roomId]: ["@bot:example.org", userId, "@extra:example.org"],
      },
      roomStateEvents: {
        [`${roomId}|m.room.member|${userId}`]: {},
        [`${roomId}|m.room.member|@bot:example.org`]: {},
      },
    });

    const resolved = await resolveMatrixRoomId(client, userId);

    expect(resolved).toBe(roomId);
  });

  it("scopes cached direct rooms per Matrix client", async () => {
    const userId = "@cache:example.org";
    const firstClient = createMockClient({
      directContent: {
        [userId]: ["!nova:example.org"],
      },
      getJoinedRoomsError: new Error("offline"),
    });
    const secondClient = createMockClient({
      directContent: {
        [userId]: ["!asst:example.org"],
      },
      getJoinedRoomsError: new Error("offline"),
    });

    const first = await resolveMatrixRoomId(firstClient, userId);
    const second = await resolveMatrixRoomId(secondClient, userId);

    expect(first).toBe("!nova:example.org");
    expect(second).toBe("!asst:example.org");
  });
});

describe("normalizeThreadId", () => {
  it("returns null for empty thread ids", () => {
    expect(normalizeThreadId("   ")).toBeNull();
    expect(normalizeThreadId("$thread")).toBe("$thread");
  });
});
