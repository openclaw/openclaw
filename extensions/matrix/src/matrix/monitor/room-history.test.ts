/**
 * Unit tests for createRoomHistoryTracker.
 *
 * Covers correctness properties that are hard to observe through the handler harness:
 * - Monotone watermark advancement (out-of-order consumeHistory must not regress)
 * - roomQueues FIFO eviction when the room count exceeds the cap
 */

import { describe, expect, it } from "vitest";
import { createRoomHistoryTracker } from "./room-history.js";

const ROOM = "!room:test";
const AGENT = "agent_a";

function entry(body: string) {
  return { sender: "user", body };
}

describe("createRoomHistoryTracker — watermark monotonicity", () => {
  it("consumeHistory is monotone: out-of-order completion does not regress the watermark", () => {
    const tracker = createRoomHistoryTracker();

    // Queue: [msg1, msg2, trigger1, msg3, trigger2]
    tracker.recordPending(ROOM, entry("msg1"));
    tracker.recordPending(ROOM, entry("msg2"));
    const snap1 = tracker.recordTrigger(ROOM, entry("trigger1")); // snap=3
    tracker.recordPending(ROOM, entry("msg3"));
    const snap2 = tracker.recordTrigger(ROOM, entry("trigger2")); // snap=5

    // trigger2 completes first (higher index)
    tracker.consumeHistory(AGENT, ROOM, snap2); // watermark → 5
    expect(tracker.getPendingHistory(AGENT, ROOM, 100)).toHaveLength(0);

    // trigger1 completes later (lower index) — must NOT regress to 3
    tracker.consumeHistory(AGENT, ROOM, snap1);
    // If regressed: [msg3, trigger2] would be visible (2 entries); must stay at 0
    expect(tracker.getPendingHistory(AGENT, ROOM, 100)).toHaveLength(0);

    // In-order advancement still works
    tracker.recordPending(ROOM, entry("msg4"));
    const snap3 = tracker.recordTrigger(ROOM, entry("trigger3")); // snap=7
    tracker.consumeHistory(AGENT, ROOM, snap3); // watermark → 7
    expect(tracker.getPendingHistory(AGENT, ROOM, 100)).toHaveLength(0);
  });

  it("prepareTrigger reuses the original history window for a retried event", () => {
    const tracker = createRoomHistoryTracker();

    tracker.recordPending(ROOM, { sender: "user", body: "msg1", messageId: "$m1" });
    const first = tracker.prepareTrigger(AGENT, ROOM, 100, {
      sender: "user",
      body: "trigger",
      messageId: "$trigger",
    });

    tracker.recordPending(ROOM, { sender: "user", body: "msg2", messageId: "$m2" });
    const retried = tracker.prepareTrigger(AGENT, ROOM, 100, {
      sender: "user",
      body: "trigger",
      messageId: "$trigger",
    });

    expect(first.history.map((entry) => entry.body)).toEqual(["msg1"]);
    expect(retried.history.map((entry) => entry.body)).toEqual(["msg1"]);
    expect(retried.snapshotIdx).toBe(first.snapshotIdx);
  });
});

describe("createRoomHistoryTracker — roomQueues eviction", () => {
  it("evicts the oldest room (FIFO) when the room count exceeds the cap", () => {
    const tracker = createRoomHistoryTracker(200, 3);

    const room1 = "!room1:test";
    const room2 = "!room2:test";
    const room3 = "!room3:test";
    const room4 = "!room4:test";

    tracker.recordPending(room1, entry("msg in room1"));
    tracker.recordPending(room2, entry("msg in room2"));
    tracker.recordPending(room3, entry("msg in room3"));

    // At cap (3 rooms) — no eviction yet
    expect(tracker.getPendingHistory(AGENT, room1, 100)).toHaveLength(1);

    // room4 pushes count to 4 > cap=3 → room1 (oldest) evicted
    tracker.recordPending(room4, entry("msg in room4"));
    expect(tracker.getPendingHistory(AGENT, room1, 100)).toHaveLength(0);
    expect(tracker.getPendingHistory(AGENT, room2, 100)).toHaveLength(1);
    expect(tracker.getPendingHistory(AGENT, room3, 100)).toHaveLength(1);
    expect(tracker.getPendingHistory(AGENT, room4, 100)).toHaveLength(1);
  });

  it("re-accessing an evicted room starts a fresh empty queue", () => {
    const tracker = createRoomHistoryTracker(200, 2);

    const room1 = "!room1:test";
    const room2 = "!room2:test";
    const room3 = "!room3:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    tracker.recordPending(room2, entry("msg in room2"));
    tracker.recordPending(room3, entry("msg in room3")); // evicts room1

    tracker.recordPending(room1, entry("new msg in room1"));
    const history = tracker.getPendingHistory(AGENT, room1, 100);
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("new msg in room1");
  });

  it("clears stale room watermarks when an evicted room is recreated", () => {
    const tracker = createRoomHistoryTracker(200, 1);
    const room1 = "!room1:test";
    const room2 = "!room2:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    const firstSnapshot = tracker.recordTrigger(room1, entry("trigger in room1"));
    tracker.consumeHistory(AGENT, room1, firstSnapshot);

    // room2 creation evicts room1 (maxRoomQueues=1)
    tracker.recordPending(room2, entry("msg in room2"));

    // Recreate room1 and add fresh content.
    tracker.recordPending(room1, entry("new msg in room1"));
    const history = tracker.getPendingHistory(AGENT, room1, 100);
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("new msg in room1");
  });

  it("ignores late consumeHistory calls after the room queue was evicted", () => {
    const tracker = createRoomHistoryTracker(200, 1);
    const room1 = "!room1:test";
    const room2 = "!room2:test";

    tracker.recordPending(room1, entry("old msg in room1"));
    const prepared = tracker.prepareTrigger(AGENT, room1, 100, {
      sender: "user",
      body: "trigger in room1",
      messageId: "$trigger",
    });

    // room2 creation evicts room1 (maxRoomQueues=1) while the trigger is still in flight.
    tracker.recordPending(room2, entry("msg in room2"));

    // Late completion for the evicted room must not recreate a stale watermark.
    tracker.consumeHistory(AGENT, room1, prepared.snapshotIdx, "$trigger");

    // Recreate room1 and add fresh content.
    tracker.recordPending(room1, entry("new msg in room1"));
    const history = tracker.getPendingHistory(AGENT, room1, 100);
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe("new msg in room1");
  });
});
