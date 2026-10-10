import { beforeEach, describe, expect, it } from "vitest";
import { createInMemorySessionStore } from "./session.js";

describe("acp session manager", () => {
  let nowMs = 0;
  const now = () => nowMs;
  let store = createInMemorySessionStore({ now });
  const createSession = (sessionId: string, target = store) =>
    target.createSession({ sessionId, sessionKey: `acp:${sessionId}`, cwd: "/tmp" });

  beforeEach(() => {
    nowMs = 1_000;
    store = createInMemorySessionStore({ now });
  });

  it("tracks active runs and clears on cancel", () => {
    const session = store.createSession({
      sessionKey: "acp:test",
      cwd: "/tmp",
    });
    const controller = new AbortController();
    store.setActiveRun(session.sessionId, "run-1", controller);

    expect(session.activeRunId).toBe("run-1");
    expect(session.abortController).toBe(controller);

    const cancelled = store.cancelActiveRun(session.sessionId);
    expect(cancelled).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(session.activeRunId).toBeNull();
    expect(session.abortController).toBeNull();
  });

  it.each(["clear", "cancel"] as const)(
    "does not let stale %s ownership remove a replacement run",
    (operation) => {
      const session = store.createSession({
        sessionKey: "acp:replacement",
        cwd: "/tmp",
      });
      store.setActiveRun(session.sessionId, "run-old", new AbortController());
      const replacementController = new AbortController();
      store.setActiveRun(session.sessionId, "run-new", replacementController);

      if (operation === "clear") {
        store.clearActiveRun(session.sessionId, "run-old");
      } else {
        expect(store.cancelActiveRun(session.sessionId, "run-old")).toBe(false);
      }

      expect(session.activeRunId).toBe("run-new");
      expect(replacementController.signal.aborted).toBe(false);
    },
  );

  it("deletes sessions and aborts active runs on close", () => {
    const session = createSession("close-me");
    const controller = new AbortController();
    store.setActiveRun(session.sessionId, "run-close", controller);

    expect(store.deleteSession(session.sessionId)).toBe(true);

    expect(controller.signal.aborted).toBe(true);
    expect(store.hasSession(session.sessionId)).toBe(false);
  });

  it("reports false when deleting a missing session", () => {
    expect(store.deleteSession("missing")).toBe(false);
  });

  it("refreshes existing session IDs instead of creating duplicates", () => {
    const first = store.createSession({
      sessionId: "existing",
      sessionKey: "acp:one",
      cwd: "/tmp/one",
    });
    nowMs += 500;

    const refreshed = store.createSession({
      sessionId: "existing",
      sessionKey: "acp:two",
      cwd: "/tmp/two",
    });

    expect(refreshed).toBe(first);
    expect(refreshed.sessionKey).toBe("acp:two");
    expect(refreshed.cwd).toBe("/tmp/two");
    expect(refreshed.createdAt).toBe(1_000);
    expect(refreshed.lastTouchedAt).toBe(1_500);
    expect(store.hasSession("existing")).toBe(true);
  });

  it("falls back for non-finite idle TTL options", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 2,
      idleTtlMs: Number.NaN,
      now,
    });
    createSession("first", boundedStore);
    nowMs += 1;
    createSession("second", boundedStore);

    expect(boundedStore.hasSession("first")).toBe(true);
    expect(boundedStore.hasSession("second")).toBe(true);
  });

  it("falls back for non-finite max session options", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: Number.NaN,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      now,
    });
    for (let index = 0; index < 5_000; index += 1) {
      const session = createSession(`session-${index}`, boundedStore);
      boundedStore.setActiveRun(session.sessionId, `run-${index}`, new AbortController());
    }

    expect(() => createSession("overflow", boundedStore)).toThrow(/session limit reached/i);
  });

  it("uses soft-cap eviction for the oldest idle session when full", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 2,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      now,
    });
    const first = createSession("first", boundedStore);
    nowMs += 100;
    const second = createSession("second", boundedStore);
    const controller = new AbortController();
    boundedStore.setActiveRun(second.sessionId, "run-2", controller);
    nowMs += 100;

    const third = createSession("third", boundedStore);

    expect(third.sessionId).toBe("third");
    expect(boundedStore.getSession(first.sessionId)).toBeUndefined();
    const retainedSession = boundedStore.getSession(second.sessionId);
    expect(retainedSession?.sessionId).toBe("second");
  });

  it("rejects when full and no session is evictable", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 1,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      now,
    });
    const only = createSession("only", boundedStore);
    boundedStore.setActiveRun(only.sessionId, "run-only", new AbortController());

    expect(() => createSession("next", boundedStore)).toThrow(/session limit reached/i);
  });

  it("reports every removal path through onSessionRemoved", () => {
    const removed: string[] = [];
    const reportingStore = createInMemorySessionStore({
      now,
      maxSessions: 2,
      idleTtlMs: 1_000,
      onSessionRemoved: (sessionId) => removed.push(sessionId),
    });

    createSession("deleted", reportingStore);
    expect(reportingStore.deleteSession("deleted")).toBe(true);
    expect(removed).toEqual(["deleted"]);

    // Idle reaping: the session ages past the TTL and is swept on the next create.
    createSession("stale", reportingStore);
    nowMs += 5_000;
    createSession("fresh", reportingStore);
    expect(removed).toEqual(["deleted", "stale"]);

    // Capacity eviction: at maxSessions the oldest idle session makes room.
    createSession("second", reportingStore);
    createSession("third", reportingStore);
    expect(removed).toEqual(["deleted", "stale", "fresh"]);

    // Dispose reports whatever was still held.
    reportingStore.dispose();
    expect(removed).toEqual(["deleted", "stale", "fresh", "second", "third"]);
  });
});
