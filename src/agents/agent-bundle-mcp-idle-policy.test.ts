import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
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

let clock: ReturnType<typeof createGatewaySchedulerClock>;
let scheduler: ReturnType<typeof createTestGatewayScheduler>;
beforeEach(() => {
  clock = createGatewaySchedulerClock(100_000);
  scheduler = createTestGatewayScheduler(clock.clock);
  vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
});
afterEach(async () => {
  await scheduler.stop();
  vi.restoreAllMocks();
});

it.each([undefined, 0] as const)(
  "keeps session runtimes alive with TTL %s without scheduling idle maintenance",
  async (sessionIdleTtlMs) => {
    const manager = createSessionMcpRuntimeManager({
      scheduler,
    });
    const params: RuntimeParams = {
      sessionId: "session-keep-alive",
      workspaceDir: "/workspace",
      cfg: idleConfig(sessionIdleTtlMs),
    };
    try {
      const runtime = await manager.getOrCreate(params);
      await clock.advanceBy(86_400_000);
      expect(manager.peekSession({ sessionId: params.sessionId })).toBe(runtime);
      expect(scheduler.nextWakeAtMs).toBeNull();
    } finally {
      await manager.disposeAll();
    }
  },
);

it("changes idle policy on reuse and reload without replacing the runtime", async () => {
  const manager = createSessionMcpRuntimeManager({
    scheduler,
  });
  const params: RuntimeParams = {
    sessionId: "session-policy",
    workspaceDir: "/workspace",
    cfg: idleConfig(),
  };
  try {
    const runtime = await manager.getOrCreate(params);
    params.cfg = idleConfig(120_000);
    expect(await manager.getOrCreate(params)).toBe(runtime);
    await clock.advanceBy(60_000);
    expect(manager.peekSession({ sessionId: params.sessionId })).toBe(runtime);
    await manager.reloadConfig({ cfg: idleConfig() });
    // A turn prepared before publication must not restore its former idle policy.
    expect(await manager.getOrCreate(params)).toBe(runtime);
    expect(scheduler.nextWakeAtMs).toBeNull();
    await clock.advanceBy(86_400_000);
    expect(manager.peekSession({ sessionId: params.sessionId })).toBe(runtime);
    await manager.reloadConfig({ cfg: idleConfig(1_000) });
    await clock.advanceBy(60_000);
    expect(manager.listRuntimeKeys()).toEqual([]);
    expect(scheduler.nextWakeAtMs).toBeNull();
  } finally {
    await manager.disposeAll();
  }
});

it("sweeps admitted runtimes only with an opt-in idle timer and stops maintenance after disposal", async () => {
  const manager = createSessionMcpRuntimeManager({ scheduler });
  const params: RuntimeParams = {
    sessionId: "session-idle-timer",
    workspaceDir: "/workspace",
    cfg: idleConfig(600_000),
  };
  try {
    await manager.getOrCreate(params);
    await manager.getOrCreate(params);
    expect(scheduler.nextWakeAtMs).toBe(160_000);
    await clock.advanceBy(60_000);
    expect(manager.listSessionIds()).toEqual([params.sessionId]);
    await clock.advanceBy(540_000);
    expect(manager.listSessionIds()).toEqual([]);
    expect(scheduler.nextWakeAtMs).toBeNull();

    await manager.getOrCreate(params);
    expect(scheduler.nextWakeAtMs).toBe(760_000);
    await manager.disposeAll();
    expect(scheduler.nextWakeAtMs).toBeNull();
  } finally {
    await manager.disposeAll();
  }
});
