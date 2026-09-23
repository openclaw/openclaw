import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";

type RuntimeParams = Parameters<
  ReturnType<typeof createSessionMcpRuntimeManager>["getOrCreate"]
>[0];

function idleConfig(sessionIdleTtlMs?: number): OpenClawConfig {
  return {
    plugins: { enabled: false },
    mcp: {
      sessionIdleTtlMs,
      servers: { fixture: { command: process.execPath } },
    },
  };
}

afterEach(() => vi.useRealTimers());

it.each([undefined, 0] as const)(
  "keeps session runtimes alive with TTL %s without scheduling idle maintenance",
  async (sessionIdleTtlMs) => {
    vi.useFakeTimers();
    const manager = createSessionMcpRuntimeManager();
    const params: RuntimeParams = {
      sessionId: "session-keep-alive",
      workspaceDir: "/workspace",
      cfg: idleConfig(sessionIdleTtlMs),
    };
    try {
      const runtime = await manager.getOrCreate(params);
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(manager.peekSession({ sessionId: params.sessionId })).toBe(runtime);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await manager.disposeAll();
    }
  },
);

it("changes idle policy on reuse and reload without replacing the runtime", async () => {
  vi.useFakeTimers();
  const manager = createSessionMcpRuntimeManager();
  const params: RuntimeParams = {
    sessionId: "session-policy",
    workspaceDir: "/workspace",
    cfg: idleConfig(),
  };
  try {
    const runtime = await manager.getOrCreate(params);
    params.cfg = idleConfig(120_000);
    expect(await manager.getOrCreate(params)).toBe(runtime);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.peekSession({ sessionId: params.sessionId })).toBe(runtime);
    await manager.reloadConfig({ cfg: idleConfig() });
    // A turn prepared before publication must not restore its former idle policy.
    expect(await manager.getOrCreate(params)).toBe(runtime);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(manager.peekSession({ sessionId: params.sessionId })).toBe(runtime);
    await manager.reloadConfig({ cfg: idleConfig(1_000) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.listRuntimeKeys()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await manager.disposeAll();
  }
});

it("sweeps admitted runtimes only with an opt-in idle timer and stops maintenance after disposal", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const now = vi.fn(() => Date.now());
  const manager = createSessionMcpRuntimeManager({ now });
  const params: RuntimeParams = {
    sessionId: "session-idle-timer",
    workspaceDir: "/workspace",
    cfg: idleConfig(600_000),
  };
  try {
    await manager.getOrCreate(params);
    await manager.getOrCreate(params);
    now.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(manager.listSessionIds()).toEqual([params.sessionId]);
    expect(now).toHaveBeenCalledTimes(9);
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.listSessionIds()).toEqual([]);
    expect(now).toHaveBeenCalledTimes(10);

    await manager.disposeAll();
    now.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(now).not.toHaveBeenCalled();
  } finally {
    await manager.disposeAll();
  }
});
