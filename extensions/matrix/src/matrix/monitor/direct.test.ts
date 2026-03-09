import { describe, expect, it, vi } from "vitest";
import { createDirectRoomTracker } from "./direct.js";

// ---------------------------------------------------------------------------
// Helpers -- minimal MatrixClient stub
// ---------------------------------------------------------------------------

type StateEvent = Record<string, unknown>;
type DmMap = Record<string, boolean>;

function createMockClient(opts: {
  dmRooms?: DmMap;
  membersByRoom?: Record<string, string[]>;
  stateEvents?: Record<string, StateEvent>;
  selfUserId?: string;
}) {
  const {
    dmRooms = {},
    membersByRoom = {},
    stateEvents = {},
    selfUserId = "@bot:example.org",
  } = opts;

  return {
    dms: {
      isDm: (roomId: string) => dmRooms[roomId] ?? false,
      update: vi.fn().mockResolvedValue(undefined),
    },
    getUserId: vi.fn().mockResolvedValue(selfUserId),
    getJoinedRoomMembers: vi.fn().mockImplementation(async (roomId: string) => {
      return membersByRoom[roomId] ?? [];
    }),
    getRoomStateEvent: vi
      .fn()
      .mockImplementation(async (roomId: string, eventType: string, stateKey: string) => {
        const key = `${roomId}|${eventType}|${stateKey}`;
        const ev = stateEvents[key];
        if (ev === undefined) {
          // Simulate real homeserver M_NOT_FOUND response (matches MatrixError shape)
          const err = new Error(`State event not found: ${key}`) as Error & {
            errcode?: string;
            statusCode?: number;
          };
          err.errcode = "M_NOT_FOUND";
          err.statusCode = 404;
          throw err;
        }
        return ev;
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests -- isDirectMessage
// ---------------------------------------------------------------------------

describe("createDirectRoomTracker", () => {
  describe("m.direct detection (SDK DM cache)", () => {
    it("returns true when SDK DM cache marks room as DM", async () => {
      const client = createMockClient({
        dmRooms: { "!dm:example.org": true },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!dm:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(true);
    });

    it("returns false for rooms not in SDK DM cache (with >2 members)", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!group:example.org": ["@alice:example.org", "@bob:example.org", "@carol:example.org"],
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!group:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(false);
    });
  });

  describe("is_direct state flag detection", () => {
    it("returns true when sender's membership has is_direct=true", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: { "!room:example.org": ["@alice:example.org", "@bot:example.org"] },
        stateEvents: {
          "!room:example.org|m.room.member|@alice:example.org": { is_direct: true },
          "!room:example.org|m.room.member|@bot:example.org": { is_direct: false },
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(true);
    });

    it("returns true when bot's own membership has is_direct=true", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: { "!room:example.org": ["@alice:example.org", "@bot:example.org"] },
        stateEvents: {
          "!room:example.org|m.room.member|@alice:example.org": { is_direct: false },
          "!room:example.org|m.room.member|@bot:example.org": { is_direct: true },
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
        selfUserId: "@bot:example.org",
      });

      expect(result).toBe(true);
    });
  });

  describe("conservative fallback (memberCount + room name)", () => {
    it("returns true for 2-member room WITHOUT a room name (broken flags)", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!broken-dm:example.org": ["@alice:example.org", "@bot:example.org"],
        },
        stateEvents: {
          // is_direct not set on either member (e.g. Continuwuity bug)
          "!broken-dm:example.org|m.room.member|@alice:example.org": {},
          "!broken-dm:example.org|m.room.member|@bot:example.org": {},
          // No m.room.name -> getRoomStateEvent will throw (event not found)
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!broken-dm:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(true);
    });

    it("returns true for 2-member room with empty room name", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!broken-dm:example.org": ["@alice:example.org", "@bot:example.org"],
        },
        stateEvents: {
          "!broken-dm:example.org|m.room.member|@alice:example.org": {},
          "!broken-dm:example.org|m.room.member|@bot:example.org": {},
          "!broken-dm:example.org|m.room.name|": { name: "" },
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!broken-dm:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(true);
    });

    it("returns false for 2-member room WITH a room name (named group)", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!named-group:example.org": ["@alice:example.org", "@bob:example.org"],
        },
        stateEvents: {
          "!named-group:example.org|m.room.member|@alice:example.org": {},
          "!named-group:example.org|m.room.member|@bob:example.org": {},
          "!named-group:example.org|m.room.name|": { name: "Project Alpha" },
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!named-group:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(false);
    });

    it("returns false for 3+ member room without any DM signals", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!group:example.org": ["@alice:example.org", "@bob:example.org", "@carol:example.org"],
        },
        stateEvents: {
          "!group:example.org|m.room.member|@alice:example.org": {},
          "!group:example.org|m.room.member|@bob:example.org": {},
          "!group:example.org|m.room.member|@carol:example.org": {},
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!group:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(false);
    });

    it("returns false for 1-member room (self-chat)", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!solo:example.org": ["@bot:example.org"],
        },
        stateEvents: {
          "!solo:example.org|m.room.member|@bot:example.org": {},
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!solo:example.org",
        senderId: "@bot:example.org",
      });

      expect(result).toBe(false);
    });
  });

  describe("detection priority", () => {
    it("m.direct takes priority -- skips state and fallback checks", async () => {
      const client = createMockClient({
        dmRooms: { "!dm:example.org": true },
        membersByRoom: {
          "!dm:example.org": ["@alice:example.org", "@bob:example.org", "@carol:example.org"],
        },
        stateEvents: {
          "!dm:example.org|m.room.name|": { name: "Named Room" },
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!dm:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(true);
      // Should not have checked member state or room name
      expect(client.getRoomStateEvent).not.toHaveBeenCalled();
      expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
    });

    it("is_direct takes priority over fallback -- skips member count", async () => {
      const client = createMockClient({
        dmRooms: {},
        stateEvents: {
          "!room:example.org|m.room.member|@alice:example.org": { is_direct: true },
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!room:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(true);
      // Should not have checked member count
      expect(client.getJoinedRoomMembers).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("handles member count API failure gracefully", async () => {
      const client = createMockClient({
        dmRooms: {},
        stateEvents: {
          "!failing:example.org|m.room.member|@alice:example.org": {},
          "!failing:example.org|m.room.member|@bot:example.org": {},
        },
      });
      client.getJoinedRoomMembers.mockRejectedValue(new Error("API unavailable"));
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!failing:example.org",
        senderId: "@alice:example.org",
      });

      // Cannot determine member count -> conservative: classify as group
      expect(result).toBe(false);
    });

    it("treats M_NOT_FOUND for room name as no name (DM)", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!no-name:example.org": ["@alice:example.org", "@bot:example.org"],
        },
        stateEvents: {
          "!no-name:example.org|m.room.member|@alice:example.org": {},
          "!no-name:example.org|m.room.member|@bot:example.org": {},
          // m.room.name not in stateEvents -> mock throws generic Error
        },
      });
      // Override to throw M_NOT_FOUND like a real homeserver
      const originalImpl = client.getRoomStateEvent.getMockImplementation()!;
      client.getRoomStateEvent.mockImplementation(
        async (roomId: string, eventType: string, stateKey: string) => {
          if (eventType === "m.room.name") {
            const err = new Error("not found") as Error & {
              errcode?: string;
              statusCode?: number;
            };
            err.errcode = "M_NOT_FOUND";
            err.statusCode = 404;
            throw err;
          }
          return originalImpl(roomId, eventType, stateKey);
        },
      );
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!no-name:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(true);
    });

    it("treats non-404 room name errors as unknown (falls through to group)", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!error-room:example.org": ["@alice:example.org", "@bot:example.org"],
        },
        stateEvents: {
          "!error-room:example.org|m.room.member|@alice:example.org": {},
          "!error-room:example.org|m.room.member|@bot:example.org": {},
        },
      });
      // Simulate a network/auth error (not M_NOT_FOUND)
      const originalImpl = client.getRoomStateEvent.getMockImplementation()!;
      client.getRoomStateEvent.mockImplementation(
        async (roomId: string, eventType: string, stateKey: string) => {
          if (eventType === "m.room.name") {
            throw new Error("Connection refused");
          }
          return originalImpl(roomId, eventType, stateKey);
        },
      );
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!error-room:example.org",
        senderId: "@alice:example.org",
      });

      // Network error -> don't assume DM, classify as group
      expect(result).toBe(false);
    });

    it("whitespace-only room name is treated as no name", async () => {
      const client = createMockClient({
        dmRooms: {},
        membersByRoom: {
          "!ws-name:example.org": ["@alice:example.org", "@bot:example.org"],
        },
        stateEvents: {
          "!ws-name:example.org|m.room.member|@alice:example.org": {},
          "!ws-name:example.org|m.room.member|@bot:example.org": {},
          "!ws-name:example.org|m.room.name|": { name: "   " },
        },
      });
      const tracker = createDirectRoomTracker(client as never);

      const result = await tracker.isDirectMessage({
        roomId: "!ws-name:example.org",
        senderId: "@alice:example.org",
      });

      expect(result).toBe(true);
    });
  });
});
