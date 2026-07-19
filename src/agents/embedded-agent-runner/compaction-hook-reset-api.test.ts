// Verifies deferred after-compaction reset queue behavior.
import { describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedHookApi,
  createEmbeddedHookSessionResetQueue,
} from "./compaction-hook-reset-api.js";

const resetMocks = vi.hoisted(() => ({
  performGatewaySessionReset: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: resetMocks.performGatewaySessionReset,
}));

describe("createEmbeddedHookSessionResetQueue", () => {
  it("accepts reason-only reset calls for the current hook session", async () => {
    const deferResetSession = vi.fn();
    const api = buildEmbeddedHookApi({
      sessionKey: "agent:main:session-1",
      agentId: "main",
      commandSource: "test",
      deferResetSession,
    });

    await expect(api.resetSession("new")).resolves.toEqual({
      ok: true,
      key: "agent:main:session-1",
      deferred: true,
    });

    expect(deferResetSession).toHaveBeenCalledWith({
      key: "agent:main:session-1",
      agentId: "main",
      reason: "new",
      commandSource: "test",
    });
  });

  it("defaults reset calls to reset reason", async () => {
    const deferResetSession = vi.fn();
    const api = buildEmbeddedHookApi({
      sessionKey: "agent:main:session-1",
      agentId: "main",
      commandSource: "test",
      deferResetSession,
    });

    await expect(api.resetSession()).resolves.toEqual({
      ok: true,
      key: "agent:main:session-1",
      deferred: true,
    });

    expect(deferResetSession).toHaveBeenCalledWith({
      key: "agent:main:session-1",
      agentId: "main",
      reason: "reset",
      commandSource: "test",
    });
  });

  it("rejects reset calls that pass a session key instead of a reason", async () => {
    const api = buildEmbeddedHookApi({
      sessionKey: "agent:main:session-1",
      deferResetSession: vi.fn(),
    });

    await expect(api.resetSession("agent:main:session-1" as "reset")).rejects.toThrow(
      /reason "new" or "reset"/,
    );
  });

  it("passes current-lifecycle assertions through deferred reset flushes", async () => {
    const assertCurrent = vi.fn();
    const onCommitted = vi.fn();
    const queue = createEmbeddedHookSessionResetQueue();

    queue.deferResetSession({
      key: "agent:main:session-1",
      agentId: "main",
      reason: "new",
      commandSource: "embedded-agent:hook",
      assertCurrent,
      onCommitted,
    });

    await queue.flush();

    expect(resetMocks.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:main:session-1",
      agentId: "main",
      reason: "new",
      commandSource: "embedded-agent:hook",
      assertCurrent,
      onCommitted,
    });
  });
});
