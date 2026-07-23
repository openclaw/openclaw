// Verifies deferred after-compaction reset queue behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    resetMocks.performGatewaySessionReset.mockReset().mockResolvedValue({ ok: true });
  });

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

  it("drains reset requests that arrive while a flush is in progress", async () => {
    let releaseFirstReset!: () => void;
    resetMocks.performGatewaySessionReset.mockImplementation(async () => {
      if (resetMocks.performGatewaySessionReset.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstReset = resolve;
        });
      }
      return { ok: true };
    });
    const queue = createEmbeddedHookSessionResetQueue();

    await queue.deferResetSession({
      key: "agent:main:session-1",
      agentId: "main",
      reason: "reset",
      commandSource: "embedded-agent:hook",
    });
    const flushing = queue.flush();

    await vi.waitFor(() => {
      expect(resetMocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    });
    const secondDefer = queue.deferResetSession({
      key: "agent:main:session-2",
      agentId: "main",
      reason: "new",
      commandSource: "embedded-agent:hook",
    });

    releaseFirstReset();
    await Promise.all([secondDefer, flushing]);

    expect(resetMocks.performGatewaySessionReset).toHaveBeenCalledTimes(2);
    expect(resetMocks.performGatewaySessionReset).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        key: "agent:main:session-1",
      }),
    );
    expect(resetMocks.performGatewaySessionReset).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        key: "agent:main:session-2",
      }),
    );
  });

  it("drains reset requests that arrive after the lifecycle flush completed", async () => {
    const queue = createEmbeddedHookSessionResetQueue();

    await queue.flush();
    await queue.deferResetSession({
      key: "agent:main:session-1",
      agentId: "main",
      reason: "reset",
      commandSource: "embedded-agent:hook",
    });

    expect(resetMocks.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:main:session-1",
      agentId: "main",
      reason: "reset",
      commandSource: "embedded-agent:hook",
    });
  });
});
