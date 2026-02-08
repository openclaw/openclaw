import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { parseSessionMeta, resolveSessionKey, startResetIfNeeded } from "./session-mapper.js";

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
    if (method === "sessions.reset") {
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

  it("startResetIfNeeded returns null when reset not needed", () => {
    const { gateway } = createGateway();
    const meta = parseSessionMeta({});

    const resetPromise = startResetIfNeeded({
      meta,
      sessionKey: "agent:main:main",
      gateway,
      opts: {},
    });

    expect(resetPromise).toBeNull();
  });

  it("startResetIfNeeded returns promise when resetSession is true", async () => {
    const { gateway, request } = createGateway();
    const meta = parseSessionMeta({ resetSession: true });

    const resetPromise = startResetIfNeeded({
      meta,
      sessionKey: "agent:main:main",
      gateway,
      opts: {},
    });

    expect(resetPromise).not.toBeNull();
    expect(resetPromise).toBeInstanceOf(Promise);

    // Wait for the reset to complete
    await resetPromise;

    // Verify the reset was called
    expect(request).toHaveBeenCalledWith("sessions.reset", { key: "agent:main:main" });
  });

  it("startResetIfNeeded returns promise when opts.resetSession is true", async () => {
    const { gateway, request } = createGateway();
    const meta = parseSessionMeta({});

    const resetPromise = startResetIfNeeded({
      meta,
      sessionKey: "agent:main:main",
      gateway,
      opts: { resetSession: true },
    });

    expect(resetPromise).not.toBeNull();
    await resetPromise;
    expect(request).toHaveBeenCalledWith("sessions.reset", { key: "agent:main:main" });
  });
});
