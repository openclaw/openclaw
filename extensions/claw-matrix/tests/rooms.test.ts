import assert from "node:assert/strict";
/**
 * Tests for rooms.ts — processStateEvents state machine.
 *
 * Tests the pure/synchronous parts of room state tracking:
 * encryption state, room names, member tracking, DM detection.
 *
 * Does NOT test async functions that depend on matrixFetch (getMemberDisplayName,
 * isDmRoomAsync) — those require integration test mocking.
 */
import { describe, it, beforeEach } from "node:test";
import type { MatrixEvent } from "../src/types.js";
import {
  processStateEvents,
  isRoomEncrypted,
  setRoomEncrypted,
  isDmRoom,
  getRoomName,
  getRoomMembers,
  cleanupRoom,
  getTrackedRoomIds,
} from "../src/client/rooms.js";

// Helper to create state events
function makeEvent(type: string, content: Record<string, unknown>, stateKey?: string): MatrixEvent {
  return { type, content, state_key: stateKey };
}

describe("processStateEvents", () => {
  // NOTE: rooms.ts uses module-level singletons. The caches persist across tests.
  // We use unique room IDs per test to avoid interference.

  describe("encryption state tracking", () => {
    it("should mark a room as encrypted on m.room.encryption event", () => {
      const roomId = "!enc-test-1:example.com";
      assert.equal(isRoomEncrypted(roomId), false);

      processStateEvents(roomId, [
        makeEvent("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }),
      ]);

      assert.equal(isRoomEncrypted(roomId), true);
    });

    it("should be write-once: encryption cannot be unset", () => {
      const roomId = "!enc-test-2:example.com";
      setRoomEncrypted(roomId);
      assert.equal(isRoomEncrypted(roomId), true);

      // Even after cleanup, encryption state should persist
      cleanupRoom(roomId);
      assert.equal(isRoomEncrypted(roomId), true);
    });
  });

  describe("room name resolution", () => {
    it("should track m.room.name events", () => {
      const roomId = "!name-test-1:example.com";
      processStateEvents(roomId, [makeEvent("m.room.name", { name: "Test Room" })]);
      assert.equal(getRoomName(roomId), "Test Room");
    });

    it("should update room name on newer events", () => {
      const roomId = "!name-test-2:example.com";
      processStateEvents(roomId, [makeEvent("m.room.name", { name: "Old Name" })]);
      processStateEvents(roomId, [makeEvent("m.room.name", { name: "New Name" })]);
      assert.equal(getRoomName(roomId), "New Name");
    });

    it("should ignore m.room.name with non-string name", () => {
      const roomId = "!name-test-3:example.com";
      processStateEvents(roomId, [makeEvent("m.room.name", { name: 42 })]);
      assert.equal(getRoomName(roomId), undefined);
    });

    it("should return undefined for unknown rooms", () => {
      assert.equal(getRoomName("!unknown:example.com"), undefined);
    });
  });

  describe("member tracking", () => {
    it("should track joined members", () => {
      const roomId = "!member-test-1:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@alice:example.com"),
        makeEvent("m.room.member", { membership: "join" }, "@bob:example.com"),
      ]);
      const members = getRoomMembers(roomId);
      assert.equal(members.size, 2);
      assert.ok(members.has("@alice:example.com"));
      assert.ok(members.has("@bob:example.com"));
    });

    it("should remove members on leave", () => {
      const roomId = "!member-test-2:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@alice:example.com"),
        makeEvent("m.room.member", { membership: "join" }, "@bob:example.com"),
      ]);
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "leave" }, "@bob:example.com"),
      ]);
      const members = getRoomMembers(roomId);
      assert.equal(members.size, 1);
      assert.ok(members.has("@alice:example.com"));
      assert.ok(!members.has("@bob:example.com"));
    });

    it("should remove members on ban", () => {
      const roomId = "!member-test-3:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@alice:example.com"),
        makeEvent("m.room.member", { membership: "join" }, "@troll:example.com"),
      ]);
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "ban" }, "@troll:example.com"),
      ]);
      const members = getRoomMembers(roomId);
      assert.equal(members.size, 1);
      assert.ok(!members.has("@troll:example.com"));
    });

    it("should skip member events without state_key", () => {
      const roomId = "!member-test-4:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }), // no state_key
      ]);
      const members = getRoomMembers(roomId);
      assert.equal(members.size, 0);
    });

    it("should return empty set for unknown rooms", () => {
      const members = getRoomMembers("!nonexistent:example.com");
      assert.equal(members.size, 0);
    });
  });

  describe("DM detection (heuristic)", () => {
    it("should detect DM rooms (2 members)", () => {
      const roomId = "!dm-test-1:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@bot:example.com"),
        makeEvent("m.room.member", { membership: "join" }, "@user:example.com"),
      ]);
      // isDmRoom uses m.direct cache first; when null, falls back to heuristic
      // Since we haven't initialized m.direct, it should use the heuristic
      assert.equal(isDmRoom(roomId), true);
    });

    it("should detect group rooms (3+ members)", () => {
      const roomId = "!dm-test-2:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@alice:example.com"),
        makeEvent("m.room.member", { membership: "join" }, "@bob:example.com"),
        makeEvent("m.room.member", { membership: "join" }, "@charlie:example.com"),
      ]);
      assert.equal(isDmRoom(roomId), false);
    });

    it("should update DM status when members change", () => {
      const roomId = "!dm-test-3:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@a:example.com"),
        makeEvent("m.room.member", { membership: "join" }, "@b:example.com"),
      ]);
      assert.equal(isDmRoom(roomId), true);

      // Third member joins -> becomes group
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@c:example.com"),
      ]);
      assert.equal(isDmRoom(roomId), false);

      // Third member leaves -> back to DM
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "leave" }, "@c:example.com"),
      ]);
      assert.equal(isDmRoom(roomId), true);
    });

    it("should treat single-member rooms as DM (self-chat)", () => {
      const roomId = "!dm-test-4:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@alone:example.com"),
      ]);
      // <= 2 members is DM per the code
      assert.equal(isDmRoom(roomId), true);
    });
  });

  describe("combined state processing", () => {
    it("should handle mixed event types in one batch", () => {
      const roomId = "!combined-1:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }),
        makeEvent("m.room.name", { name: "Secret Room" }),
        makeEvent("m.room.member", { membership: "join" }, "@alice:example.com"),
        makeEvent("m.room.member", { membership: "join" }, "@bob:example.com"),
      ]);

      assert.equal(isRoomEncrypted(roomId), true);
      assert.equal(getRoomName(roomId), "Secret Room");
      assert.equal(getRoomMembers(roomId).size, 2);
    });

    it("should ignore unknown event types", () => {
      const roomId = "!combined-2:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.topic", { topic: "A topic" }),
        makeEvent("m.room.avatar", { url: "mxc://example.com/avatar" }),
      ]);
      // Should not throw, and state should not be affected
      assert.equal(getRoomName(roomId), undefined);
    });
  });

  describe("cleanupRoom", () => {
    it("should clear room type, name, and members but preserve encryption", () => {
      const roomId = "!cleanup-1:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }),
        makeEvent("m.room.name", { name: "Room" }),
        makeEvent("m.room.member", { membership: "join" }, "@user:example.com"),
      ]);

      cleanupRoom(roomId);

      assert.equal(isRoomEncrypted(roomId), true, "encryption should persist");
      assert.equal(getRoomName(roomId), undefined, "name should be cleared");
      assert.equal(getRoomMembers(roomId).size, 0, "members should be cleared");
    });
  });

  describe("getTrackedRoomIds", () => {
    it("should return IDs of rooms with state", () => {
      const roomId = "!tracked-1:example.com";
      processStateEvents(roomId, [
        makeEvent("m.room.member", { membership: "join" }, "@user:example.com"),
      ]);
      const tracked = getTrackedRoomIds();
      assert.ok(tracked.includes(roomId));
    });
  });
});
