import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { parseSessionMeta, resolveSessionKey } from "./session-mapper.js";
import { createInMemorySessionStore } from "./session.js";

function createGateway(resolveLabelKey = "agent:main:label"): {
  gateway: GatewayClient;
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.resolve" && "label" in params) {
      return { ok: true, key: resolveLabelKey };
    }
    if (method === "sessions.resolve" && "key" in params) {
      return { ok: true, key: params.key as string };
    }
    return { ok: true };
  });

  return {
    gateway: { request } as unknown as GatewayClient,
    request,
  };
}

describe("acp session mapper", () => {
  it("prefers explicit sessionLabel over sessionKey", async () => {
    const { gateway, request } = createGateway();
    const meta = parseSessionMeta({ sessionLabel: "support", sessionKey: "agent:main:main" });

    const key = await resolveSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: {},
    });

    expect(key).toBe("agent:main:label");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("sessions.resolve", { label: "support" });
  });

  it("lets meta sessionKey override default label", async () => {
    const { gateway, request } = createGateway();
    const meta = parseSessionMeta({ sessionKey: "agent:main:override" });

    const key = await resolveSessionKey({
      meta,
      fallbackKey: "acp:fallback",
      gateway,
      opts: { defaultSessionLabel: "default-label" },
    });

    expect(key).toBe("agent:main:override");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("acp session manager", () => {
  let nowMs = 0;
  const now = () => nowMs;
  const advance = (ms: number) => {
    nowMs += ms;
  };
  let store = createInMemorySessionStore({ now });

  beforeEach(() => {
    nowMs = 1_000;
    store = createInMemorySessionStore({ now });
  });

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

  it("refreshes existing session IDs instead of creating duplicates", () => {
    const first = store.createSession({
      sessionId: "existing",
      sessionKey: "acp:one",
      cwd: "/tmp/one",
    });
    advance(500);

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
  });

  it("reaps idle sessions before enforcing the max session cap", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 1,
      idleTtlMs: 1_000,
      now,
    });
    try {
      boundedStore.createSession({
        sessionId: "old",
        sessionKey: "acp:old",
        cwd: "/tmp",
      });
      advance(2_000);
      const fresh = boundedStore.createSession({
        sessionId: "fresh",
        sessionKey: "acp:fresh",
        cwd: "/tmp",
      });

      expect(fresh.sessionId).toBe("fresh");
      expect(boundedStore.getSession("old")).toBeUndefined();
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("uses soft-cap eviction for the oldest idle session when full", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 2,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      now,
    });
    try {
      const first = boundedStore.createSession({
        sessionId: "first",
        sessionKey: "acp:first",
        cwd: "/tmp",
      });
      advance(100);
      const second = boundedStore.createSession({
        sessionId: "second",
        sessionKey: "acp:second",
        cwd: "/tmp",
      });
      const controller = new AbortController();
      boundedStore.setActiveRun(second.sessionId, "run-2", controller);
      advance(100);

      const third = boundedStore.createSession({
        sessionId: "third",
        sessionKey: "acp:third",
        cwd: "/tmp",
      });

      expect(third.sessionId).toBe("third");
      expect(boundedStore.getSession(first.sessionId)).toBeUndefined();
      expect(boundedStore.getSession(second.sessionId)).toBeDefined();
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });

  it("rejects when full and no session is evictable", () => {
    const boundedStore = createInMemorySessionStore({
      maxSessions: 1,
      idleTtlMs: 24 * 60 * 60 * 1_000,
      now,
    });
    try {
      const only = boundedStore.createSession({
        sessionId: "only",
        sessionKey: "acp:only",
        cwd: "/tmp",
      });
      boundedStore.setActiveRun(only.sessionId, "run-only", new AbortController());

      expect(() =>
        boundedStore.createSession({
          sessionId: "next",
          sessionKey: "acp:next",
          cwd: "/tmp",
        }),
      ).toThrow(/session limit reached/i);
    } finally {
      boundedStore.clearAllSessionsForTest();
    }
  });
});
