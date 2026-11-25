import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";

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

it("expires idle partitions while preserving reuse and leases", async () => {
  const registry = createMcpProofPluginRegistry();
  await withPluginRuntimeRegistryScope(registry.registry, async () => {
    registry.apiFor("test-plugin").registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: async () => ({ url: "https://mcp.example.test/user" }),
    });
    const manager = createSessionMcpRuntimeManager({ scheduler });
    const sessionKey = "agent:test:session-fixed-idle";
    const params: RuntimeParams = {
      sessionId: "session-fixed-idle",
      sessionKey,
      workspaceDir: "/workspace",
      requesterSenderId: "sender-a",
      cfg: {
        plugins: { enabled: false },
        mcp: {
          sessionIdleTtlMs: 1_200_000.9,
          servers: {
            shared: { command: "true" },
            "user-mail": { transport: "streamable-http" },
          },
        },
      },
    };
    const getRuntime = () => manager.getOrCreate(params);
    try {
      await getRuntime();
      const runtimeKeys = manager.listRuntimeKeys();
      expect(runtimeKeys).toHaveLength(2);
      await clock.advanceBy(1_200_000 - 1);
      await manager.sweepIdleRuntimes();
      expect(manager.listRuntimeKeys()).toEqual(runtimeKeys);
      const reused = expectDefined(await getRuntime(), "admitted MCP runtime");
      expect(reused.lastUsedAt).toBe(clock.clock.now());
      await clock.advanceBy(1_200_000 - 1);
      await manager.sweepIdleRuntimes();
      expect(manager.listRuntimeKeys()).toEqual(runtimeKeys);
      const release = expectDefined(reused.acquireLease, "MCP runtime lease")();
      await clock.advanceBy(1);
      await manager.sweepIdleRuntimes();
      expect(manager.listRuntimeKeys()).toEqual(runtimeKeys);
      expect(manager.listSessionIds()).toContain(params.sessionId);
      release();
      await manager.sweepIdleRuntimes();
      expect(manager.listRuntimeKeys()).toEqual([]);
      expect(manager.resolveSessionId(sessionKey)).toBeUndefined();
    } finally {
      await manager.disposeAll();
    }
  });
});

it.each([undefined, 0] as const)(
  "changes disabled idle policy %s on reuse and reload without replacing the runtime",
  async (sessionIdleTtlMs) => {
    const manager = createSessionMcpRuntimeManager({ scheduler });
    const params: RuntimeParams = {
      sessionId: "session-policy",
      workspaceDir: "/workspace",
      cfg: idleConfig(sessionIdleTtlMs),
    };
    try {
      const runtime = await manager.getOrCreate(params);
      await clock.advanceBy(86_400_000);
      expect(manager.peekSession({ sessionId: params.sessionId })).toBe(runtime);
      expect(scheduler.nextWakeAtMs).toBeNull();
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
  },
);

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

it("preserves transferred view leases and last use during capacity eviction", async () => {
  const manager = createSessionMcpRuntimeManager({ scheduler });
  const input: RuntimeParams = {
    sessionId: "transferred-view",
    workspaceDir: "/workspace",
    cfg: {
      plugins: { enabled: false },
      mcp: { servers: { shared: { command: "shared" }, changed: { command: "old" } } },
    },
  };
  let releaseView: (() => void) | undefined;
  try {
    const original = await manager.getOrCreate(input);
    releaseView = original.acquireLease!();
    const replacement = await manager.getOrCreate({
      ...input,
      cfg: {
        plugins: { enabled: false },
        mcp: { servers: { shared: { command: "shared" }, changed: { command: "new" } } },
      },
    });
    expect(replacement.activeLeases).toBeGreaterThan(0);
    await clock.advanceBy(1_000);
    for (let index = 1; index < 256; index += 1) {
      await manager.getOrCreate({ ...input, sessionId: `peer-${index}` });
    }
    await manager.getOrCreate({ ...input, sessionId: "first-overflow" });
    expect(manager.peekSession({ sessionId: input.sessionId })).toBe(replacement);
    expect(manager.peekSession({ sessionId: "peer-1" })).toBeUndefined();

    await clock.advanceBy(1_000);
    original.markUsed();
    releaseView();
    releaseView = undefined;
    await manager.getOrCreate({ ...input, sessionId: "next-overflow" });
    expect(manager.peekSession({ sessionId: input.sessionId })).toBe(replacement);
    expect(manager.peekSession({ sessionId: "peer-2" })).toBeUndefined();
  } finally {
    releaseView?.();
    await manager.disposeAll();
  }
});

it("reserves capacity for uncertain child cleanup", async () => {
  const manager = createSessionMcpRuntimeManager({ scheduler });
  const params: RuntimeParams = {
    sessionId: "uncertain-child",
    workspaceDir: "/workspace",
    cfg: { plugins: { enabled: false }, mcp: { servers: { child: { command: "true" } } } },
  };
  const leases = [];
  try {
    const previous = await manager.getOrCreate(params);
    previous.joinCleanup = async () => {
      throw new Error("child cleanup uncertain");
    };
    await expect(manager.getOrCreate({ ...params, workspaceDir: "/replacement" })).rejects.toThrow(
      "child cleanup uncertain",
    );
    for (let index = 0; index < 255; index += 1) {
      leases.push(await manager.acquire({ ...params, sessionId: `other-${index}` }));
    }
    const overflow = await manager.getOrCreate({ ...params, sessionId: "overflow" });
    expect((await overflow.getCatalog()).diagnostics?.[0]?.message).toContain(
      "all 256 Gateway MCP runtimes are in use",
    );
    expect(manager.peekSession({ sessionId: "overflow" })).toBeUndefined();
  } finally {
    leases.forEach((lease) => lease.releaseLease());
    await manager.disposeAll();
  }
});
