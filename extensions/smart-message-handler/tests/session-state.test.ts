import { describe, it, expect } from "vitest";
import {
  createSessionStore,
  recordMessage,
  getSession,
  clearSessions,
} from "../src/session-state.ts";

describe("createSessionStore", () => {
  it("creates a store with size 0", () => {
    const store = createSessionStore();
    expect(store.size).toBe(0);
  });

  it("respects custom maxSessions parameter", () => {
    const store = createSessionStore(5);
    expect(store.size).toBe(0);
  });
});

describe("recordMessage", () => {
  it("returns a new store with size 1 after first record", () => {
    const store = createSessionStore();
    const next = recordMessage(store, "user-1");
    expect(next.size).toBe(1);
  });

  it("returns a new store object, not the original (immutability)", () => {
    const store = createSessionStore();
    const next = recordMessage(store, "user-1");
    expect(store).not.toBe(next);
    expect(store.size).toBe(0);
  });

  it("initializes messageCount to 1 on first record", () => {
    const store = createSessionStore();
    const next = recordMessage(store, "user-1");
    const session = getSession(next, "user-1");
    expect(session).toBeTruthy();
    expect(session!.messageCount).toBe(1);
  });

  it("increments messageCount on consecutive records for the same session", () => {
    let store = createSessionStore();
    store = recordMessage(store, "user-1");
    store = recordMessage(store, "user-1");
    store = recordMessage(store, "user-1");
    const session = getSession(store, "user-1");
    expect(session).toBeTruthy();
    expect(session!.messageCount).toBe(3);
  });

  it("tracks intervals within 30 seconds and updates avgInterval", () => {
    let store = createSessionStore();
    store = recordMessage(store, "user-1");
    // Second message arrives quickly (well within 30s)
    store = recordMessage(store, "user-1");
    const session = getSession(store, "user-1");
    expect(session).toBeTruthy();
    expect(session!.totalIntervals).toBe(1);
    expect(session!.avgInterval >= 0).toBe(true);
  });

  it("does not update avgInterval for intervals >= 30 seconds", () => {
    // Stub Date.now to simulate a 35-second gap between messages
    const realNow = Date.now;
    let fakeTime = realNow.call(Date);
    Date.now = () => fakeTime;

    try {
      let store = createSessionStore();
      store = recordMessage(store, "user-1");

      // Advance fake clock by 35 seconds
      fakeTime += 35_000;

      store = recordMessage(store, "user-1");
      const session = getSession(store, "user-1");
      expect(session).toBeTruthy();
      // totalIntervals should still be 0 (interval was >= 30s, not tracked)
      expect(session!.totalIntervals).toBe(0);
      expect(session!.avgInterval).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });

  it("tracks multiple independent sessions with correct individual sizes", () => {
    let store = createSessionStore();
    store = recordMessage(store, "user-A");
    store = recordMessage(store, "user-B");
    expect(store.size).toBe(2);
    expect(getSession(store, "user-A")?.messageCount).toBe(1);
    expect(getSession(store, "user-B")?.messageCount).toBe(1);
  });

  it("evicts the oldest session when exceeding maxSessions (LRU)", () => {
    // maxSessions = 2; add 3 sessions — oldest should be gone
    let store = createSessionStore(2);
    store = recordMessage(store, "oldest");
    // Sleep 1ms to guarantee ordering
    const t = Date.now();
    while (Date.now() === t) {
      /* busy-wait 1ms */
    }
    store = recordMessage(store, "middle");
    while (Date.now() === t) {
      /* busy-wait */
    }
    store = recordMessage(store, "newest");

    expect(store.size).toBe(2);
    expect(getSession(store, "oldest")).toBeUndefined();
    expect(getSession(store, "middle")).toBeTruthy();
    expect(getSession(store, "newest")).toBeTruthy();
  });
});

describe("getSession", () => {
  it("returns undefined for a session key that was never recorded", () => {
    const store = createSessionStore();
    expect(getSession(store, "nonexistent")).toBeUndefined();
  });

  it("returns the correct SessionState for a recorded key", () => {
    let store = createSessionStore();
    store = recordMessage(store, "user-1");
    const session = getSession(store, "user-1");
    expect(session).toBeTruthy();
    expect(session!.messageCount).toBe(1);
    expect(typeof session!.lastMessageTime).toBe("number");
  });
});

describe("clearSessions", () => {
  it("returns a store with size 0 after clearing", () => {
    let store = createSessionStore();
    store = recordMessage(store, "user-1");
    store = recordMessage(store, "user-2");
    expect(store.size).toBe(2);

    const cleared = clearSessions(store);
    expect(cleared.size).toBe(0);
  });

  it("does not mutate the original store when clearing", () => {
    let store = createSessionStore();
    store = recordMessage(store, "user-1");
    const cleared = clearSessions(store);
    expect(store.size).toBe(1);
    expect(cleared.size).toBe(0);
  });

  it("cleared store can accept new messages", () => {
    let store = createSessionStore();
    store = recordMessage(store, "user-1");
    let cleared = clearSessions(store);
    cleared = recordMessage(cleared, "user-2");
    expect(cleared.size).toBe(1);
    expect(getSession(cleared, "user-2")).toBeTruthy();
  });
});
