import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemorySessionStore } from "./session.js";

describe("acp session manager", () => {
  let nowMs = 0;
  let removed: string[] = [];
  let store = createInMemorySessionStore();
  const onRemove = (id: string) => removed.push(id);
  const createSession = (sessionId?: string) =>
    store.createSession({ sessionId, sessionKey: `acp:${sessionId}`, cwd: "/tmp" });
  const startRun = (sessionId: string, runId = "run-1") => {
    const controller = new AbortController();
    store.setActiveRun(sessionId, runId, controller);
    return controller;
  };

  beforeEach(() => {
    nowMs = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    removed = [];
    store = createInMemorySessionStore({ maxSessions: 2, onSessionRemoved: onRemove });
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

  it.each(["clear", "cancel"] as const)("ignores stale %s ownership", (operation) => {
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
  });

  it("deletes sessions and aborts active runs on close", () => {
    const session = createSession("close-me");
    const controller = startRun(session.sessionId);
    expect(store.deleteSession(session.sessionId)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(store.hasSession(session.sessionId)).toBe(false);
    expect(store.deleteSession(session.sessionId)).toBe(false);
    expect(removed).toEqual(["close-me"]);
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

  it("evicts idle sessions but rejects when all remaining sessions are active", () => {
    createSession("first");
    startRun(createSession("second").sessionId);
    expect(createSession("third").sessionId).toBe("third");
    expect(store.getSession("first")).toBeUndefined();
    expect(store.getSession("second")?.sessionId).toBe("second");
    expect(removed).toEqual(["first"]);
    startRun("third");
    expect(() => createSession("next")).toThrow(/session limit reached/i);
  });

  it("reports idle reaping and disposal through onSessionRemoved", () => {
    createSession("stale");
    nowMs += 24 * 60 * 60 * 1_000 + 1;
    createSession("fresh");
    expect(removed).toEqual(["stale"]);
    createSession("second");
    store.dispose();
    expect(removed).toEqual(["stale", "fresh", "second"]);
  });
});
