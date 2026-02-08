import { describe, expect, it, afterEach } from "vitest";
import { createInMemorySessionStore } from "./session.js";

describe("acp session manager", () => {
  const store = createInMemorySessionStore();

  afterEach(() => {
    store.clearAllSessionsForTest();
  });

  it("tracks active runs and clears on cancel", () => {
    const session = store.createSession({
      sessionKey: "acp:test",
      cwd: "/tmp",
    });
    const controller = new AbortController();
    store.setActiveRun(session.sessionId, "run-1", controller);

    expect(store.getSessionByRunId("run-1")?.sessionId).toBe(session.sessionId);

    const cancelled = store.cancelActiveRun(session.sessionId);
    expect(cancelled).toBe(true);
    expect(store.getSessionByRunId("run-1")).toBeUndefined();
  });

  it("tracks pending session reset promises", async () => {
    const session = store.createSession({
      sessionKey: "acp:test",
      cwd: "/tmp",
    });

    let resetCompleted = false;
    const resetPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        resetCompleted = true;
        resolve();
      }, 10);
    });

    store.setPendingReset(session.sessionId, resetPromise);
    expect(session.pendingReset).toBe(resetPromise);

    // Verify the reset hasn't completed yet
    expect(resetCompleted).toBe(false);

    // Wait for the reset to complete
    await session.pendingReset;
    expect(resetCompleted).toBe(true);
  });
});
