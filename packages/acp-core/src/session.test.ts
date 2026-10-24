import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemorySessionStore } from "./session.js";

describe("acp session manager", () => {
  let nowMs = 0;
  let store = createInMemorySessionStore();
  const createSession = (sessionId?: string, target = store) =>
    target.createSession({ sessionId, sessionKey: `acp:${sessionId}`, cwd: "/tmp" });
  const startRun = (sessionId: string, runId = "run-1", target = store) => {
    const controller = new AbortController();
    target.setActiveRun(sessionId, runId, controller);
    return controller;
  };

  beforeEach(() => {
    nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    store = createInMemorySessionStore();
  });
  afterEach(() => vi.restoreAllMocks());

  it("tracks active runs and clears on cancel", () => {
    const session = createSession();
    const controller = startRun(session.sessionId);
    expect(session.activeRunId).toBe("run-1");
    expect(session.abortController).toBe(controller);
    expect(store.cancelActiveRun(session.sessionId)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(session).toMatchObject({ activeRunId: null, abortController: null });
  });

  it.each(["clear", "cancel"] as const)(
    "does not let stale %s ownership remove a replacement run",
    (operation) => {
      const session = createSession();
      startRun(session.sessionId, "run-old");
      const replacementController = startRun(session.sessionId, "run-new");
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
    const controller = startRun(session.sessionId);
    expect(store.deleteSession(session.sessionId)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(store.hasSession(session.sessionId)).toBe(false);
  });

  it("reports false when deleting a missing session", () => {
    expect(store.deleteSession("missing")).toBe(false);
  });

  it("refreshes existing session IDs instead of creating duplicates", () => {
    const first = createSession("existing");
    nowMs += 500;
    const update = { sessionId: "existing", sessionKey: "acp:two", cwd: "/tmp/two" };
    const refreshed = store.createSession(update);
    expect(refreshed).toBe(first);
    expect(refreshed).toMatchObject({ ...update, createdAt: 1_000, lastTouchedAt: 1_500 });
    expect(store.hasSession("existing")).toBe(true);
  });

  it("uses soft-cap eviction for the oldest idle session when full", () => {
    const boundedStore = createInMemorySessionStore({ maxSessions: 2 });
    const first = createSession("first", boundedStore);
    nowMs += 100;
    const second = createSession("second", boundedStore);
    startRun(second.sessionId, "run-2", boundedStore);
    nowMs += 100;
    expect(createSession("third", boundedStore).sessionId).toBe("third");
    expect(boundedStore.getSession(first.sessionId)).toBeUndefined();
    expect(boundedStore.getSession(second.sessionId)?.sessionId).toBe("second");
  });

  it("rejects when full and no session is evictable", () => {
    const boundedStore = createInMemorySessionStore({ maxSessions: 1 });
    const only = createSession("only", boundedStore);
    startRun(only.sessionId, "run-only", boundedStore);
    expect(() => createSession("next", boundedStore)).toThrow(/session limit reached/i);
  });

  it("reports every removal path through onSessionRemoved", () => {
    const removed: string[] = [];
    const reportingStore = createInMemorySessionStore({
      maxSessions: 2,
      onSessionRemoved: (sessionId) => removed.push(sessionId),
    });
    createSession("deleted", reportingStore);
    expect(reportingStore.deleteSession("deleted")).toBe(true);
    expect(removed).toEqual(["deleted"]);

    createSession("stale", reportingStore);
    nowMs += 24 * 60 * 60 * 1_000 + 1;
    createSession("fresh", reportingStore);
    expect(removed).toEqual(["deleted", "stale"]);

    createSession("second", reportingStore);
    createSession("third", reportingStore);
    expect(removed).toEqual(["deleted", "stale", "fresh"]);

    reportingStore.dispose();
    expect(removed).toEqual(["deleted", "stale", "fresh", "second", "third"]);
  });
});
