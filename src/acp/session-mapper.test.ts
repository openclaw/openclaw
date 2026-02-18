import { afterEach, describe, expect, it, vi } from "vitest";
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
});
