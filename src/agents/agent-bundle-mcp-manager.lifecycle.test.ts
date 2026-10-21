import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { onAgentEvent } from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { makeRuntime } from "./agent-bundle-mcp-harness.test-support.js";
import {
  acquireRequesterScopedMcpRuntime,
  acquireSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-api.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import type { SessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import {
  SESSION_MCP_RUNTIME_MANAGER_KEY,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  RequesterScopedMcpRuntimeHandle,
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
} from "./agent-bundle-mcp-types.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import { createAgentCleanupScope } from "./run-cleanup-timeout.js";

vi.mock("./agent-bundle-mcp-runtime.js", () => {
  throw new Error("Lifecycle-only MCP work must not import the transport runtime");
});

const managers: SessionMcpRuntimeManager[] = [];
const releaseHeldWork: Array<() => void> = [];
const params = {
  sessionId: "lifecycle-session",
  sessionKey: "agent:test:lifecycle-session",
  workspaceDir: "/workspace",
  agentDir: "/agents/test",
  cfg: { mcp: { servers: {} } },
  manifestRegistry: { plugins: [] },
};
const idleParams = { ...params, cfg: { mcp: { sessionIdleTtlMs: 60_000, servers: {} } } };
const nextTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function bindManager(manager: SessionMcpRuntimeManager) {
  const key = SESSION_MCP_RUNTIME_MANAGER_KEY;
  const previous = Reflect.get(globalThis, key);
  const hadManager = Reflect.has(globalThis, key);
  Reflect.set(globalThis, key, manager);
  return () =>
    hadManager ? Reflect.set(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key);
}

function createRuntimeFixture(input: Parameters<CreateSessionMcpRuntime>[0]): SessionMcpRuntime {
  const runtime = makeRuntime({ sessionId: input.sessionId, requesterSenderId: "unused" });
  return Object.assign(runtime, {
    sessionKey: input.sessionKey,
    workspaceDir: input.workspaceDir,
    agentDir: input.agentDir,
    requesterScope: input.requesterScope,
    configFingerprint: input.configFingerprint ?? "fixture",
    createdAt: runtime.lastUsedAt,
    getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
    peekCatalog: () => null,
    callTool: async () => ({ content: [] }),
    joinCleanup: async () => {},
    dispose: vi.fn(async () => {}),
  });
}

function createManager(
  createRuntime?: CreateSessionMcpRuntime,
  scheduler?: ReturnType<typeof createTestGatewayScheduler>,
) {
  const manager = createSessionMcpRuntimeManager({ createRuntime, scheduler });
  managers.push(manager);
  return manager;
}

function requesterParams(requesterSenderId: string) {
  return {
    ...params,
    requesterSenderId,
    cfg: { mcp: { servers: { scoped: { transport: "streamable-http" as const } } } },
  };
}

function withRequesterResolver(
  run: () => Promise<void>,
  resolve = async () => ({ url: "https://mcp.example.test/scoped" }),
) {
  const resolverRegistry = createMcpProofPluginRegistry();
  return withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
    resolverRegistry
      .apiFor("test-plugin")
      .registerMcpServerConnectionResolver({ serverName: "scoped", resolve });
    await run();
  });
}

function holdFactory() {
  const started = createDeferred<SessionMcpRuntime>();
  const released = createDeferred();
  releaseHeldWork.push(() => released.resolve());
  const createRuntime: CreateSessionMcpRuntime = async (input) => {
    const runtime = createRuntimeFixture(input);
    started.resolve(runtime);
    await released.promise;
    return runtime;
  };
  return { createRuntime, started: started.promise, release: () => released.resolve() };
}

function holdDisposal(runtime: SessionMcpRuntime) {
  const started = createDeferred();
  const released = createDeferred();
  releaseHeldWork.push(() => released.resolve());
  runtime.dispose = vi.fn(async () => {
    started.resolve();
    await released.promise;
  });
  return { started: started.promise, release: () => released.resolve() };
}

afterEach(async () => {
  for (const release of releaseHeldWork.splice(0)) {
    release();
  }
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
});

describe("MCP manager creation ownership", () => {
  it("evicts the idle LRU at capacity and reconnects its session on reuse", async () => {
    let now = 1_000;
    const time = vi.spyOn(Date, "now").mockImplementation(() => now);
    const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createManager(factory);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const acquire = (sessionId: string) =>
      manager.getOrCreate({ ...params, sessionId, sessionKey: `agent:test:${sessionId}`, cfg });
    try {
      for (let index = 0; index < 300; index += 1) {
        await manager.getOrCreate({ ...params, sessionId: `serverless-${index}` });
      }
      const first = await acquire("connected-0");
      now++;
      const lru = await acquire("connected-1");
      registerAgentRunContext("completed-display", {
        sessionKey: "agent:test:connected-1",
        sessionId: "connected-1",
      });
      for (let index = 2; index < 256; index += 1) {
        now++;
        await acquire(`connected-${index}`);
      }
      now++;
      expect(await acquire("connected-0")).toBe(first);
      await acquire("overflow");
      expect(lru.dispose).toHaveBeenCalledOnce();
      expect(first.dispose).not.toHaveBeenCalled();
      expect(manager.resolveSessionId("agent:test:connected-1")).toBeUndefined();
      const reconnected = await acquire("connected-1");
      expect(reconnected).not.toBe(lru);
      expect(
        factory.mock.calls.filter(([input]) => input.sessionId === "connected-1"),
      ).toHaveLength(2);
      await manager.getOrCreate({ ...params, sessionId: "serverless-at-capacity" });
    } finally {
      clearAgentRunContext("completed-display");
      time.mockRestore();
    }
  });

  it("preserves active runs, leases, views, and pending requester acquisition at capacity", async () => {
    const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createManager(factory);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const activeRun = await manager.getOrCreate({
      ...params,
      sessionId: "running",
      sessionKey: undefined,
      cfg,
    });
    const runClaim = claimAgentRunContext(
      "mcp-running",
      { sessionId: "running" },
      { trackOwner: true, ownsContext: true },
    );
    const lease = await manager.acquire({ ...params, sessionId: "leased", cfg });
    const viewed = await manager.getOrCreate({ ...params, sessionId: "viewed", cfg });
    const releaseView = viewed.acquireLease!();
    try {
      await withRequesterResolver(async () => {
        const pendingRuntime = (await manager.getOrCreateRequesterScoped({
          ...requesterParams("sender"),
          sessionId: "pending",
        }))!.runtime;
        const held = holdFactory();
        factory.mockImplementationOnce(held.createRuntime);
        const pending = manager.acquireRequesterScoped({
          ...requesterParams("sender"),
          sessionId: "pending",
          workspaceDir: "/changed",
        });
        await held.started;
        for (let index = 4; index < 256; index += 1) {
          await manager.getOrCreate({ ...params, sessionId: `idle-${index}`, cfg });
        }
        const idle = manager.peekSession({ sessionId: "idle-4" })!;
        await manager.getOrCreate({ ...params, sessionId: "overflow", cfg });
        expect(idle.dispose).toHaveBeenCalledOnce();
        expect(activeRun.dispose).not.toHaveBeenCalled();
        expect(lease.runtime.dispose).not.toHaveBeenCalled();
        expect(viewed.dispose).not.toHaveBeenCalled();
        // Replacement owns cleanup of the predecessor, but capacity cannot retire the admitted successor.
        held.release();
        const acquired = (await pending)!;
        expect(
          manager.peekSession({
            sessionId: manager
              .listRuntimeKeys()
              .find((key) => key.includes('"sessionId":"pending"'))!,
          }),
        ).toBe(acquired.runtime);
        expect(acquired.runtime.dispose).not.toHaveBeenCalled();
        expect(pendingRuntime.dispose).toHaveBeenCalledOnce();
        acquired.releaseLease();
      });
    } finally {
      releaseAgentRunContext("mcp-running", runClaim);
      lease.releaseLease();
      releaseView();
    }
  });

  it("continues without tools when all slots are busy and warns once per capacity episode", async () => {
    const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createManager(factory);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const leases = [];
    for (let index = 0; index < 256; index += 1) {
      leases.push(await manager.acquire({ ...params, sessionId: `busy-${index}`, cfg }));
    }
    const notices: string[] = [];
    const stop = onAgentEvent((event) => {
      if (event.stream === "notice") {
        notices.push(String(event.data.message));
      }
    });
    const overflowClaim = claimAgentRunContext(
      "mcp-overflow",
      {
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
      },
      { trackOwner: true, ownsContext: true },
    );
    try {
      for (let index = 0; index < 2; index += 1) {
        const tools = await materializeBundleMcpToolsForRun(
          await manager.acquire({ ...params, cfg }),
        );
        expect(tools.tools).toEqual([]);
        expect(tools.diagnostics?.[0]?.message).toContain(
          "This turn will continue without MCP tools",
        );
        await tools.dispose();
      }
      expect(notices).toHaveLength(1);
      expect(factory).toHaveBeenCalledTimes(256);
      leases[0]!.releaseLease();
      const admitted = await manager.acquire({ ...params, sessionId: "after-idle", cfg });
      leases.push(admitted);
      expect(factory).toHaveBeenCalledTimes(257);
      const next = await manager.acquire({ ...params, cfg });
      next.releaseLease();
      expect(notices).toHaveLength(2);
    } finally {
      stop();
      releaseAgentRunContext("mcp-overflow", overflowClaim);
      leases.forEach((lease) => lease.releaseLease());
    }
  });

  it("bounds capacity cleanup waiting across consecutive idle owners", async () => {
    const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createManager(factory);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const first = await manager.getOrCreate({ ...params, sessionId: "slow-first", cfg });
    const second = await manager.getOrCreate({ ...params, sessionId: "slow-second", cfg });
    const firstClosing = holdDisposal(first);
    const secondClosing = holdDisposal(second);
    first.joinCleanup = async () => {
      throw new Error("first cleanup could not confirm closure");
    };
    const leases: SessionMcpRuntimeLease[] = [];
    for (let index = 0; index < 254; index += 1) {
      leases.push(await manager.acquire({ ...params, sessionId: `busy-${index}`, cfg }));
    }
    let fallback: SessionMcpRuntimeLease | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const admission = manager.acquire({ ...params, sessionId: "overflow", cfg }).then((lease) => {
      fallback = lease;
    });
    try {
      await firstClosing.started;
      setTimeout(firstClosing.release, 3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await secondClosing.started;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fallback, "admission must not wait for a second full cleanup deadline").toBeDefined();
      expect((await fallback!.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
        "This turn will continue without MCP tools",
      );
      expect(factory).toHaveBeenCalledTimes(256);

      secondClosing.release();
      await manager.disposeSession("slow-second");
      leases.push(await manager.acquire({ ...params, sessionId: "after-cleanup", cfg }));
      expect(factory).toHaveBeenCalledTimes(257);
    } finally {
      firstClosing.release();
      secondClosing.release();
      await Promise.allSettled([admission]);
      fallback?.releaseLease();
      leases.forEach((lease) => lease.releaseLease());
      vi.useRealTimers();
    }
  });

  it("waits for an evicted process to close before reacquiring its session", async () => {
    const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createManager(factory);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const input = (sessionId: string) => ({ ...params, sessionId, cfg });
    const original = await manager.getOrCreate(input("slow-owner"));
    const closing = holdDisposal(original);
    await manager.getOrCreate(input("fast-owner"));
    const leases: SessionMcpRuntimeLease[] = [];
    for (let index = 0; index < 254; index++) {
      leases.push(await manager.acquire(input(`busy-${index}`)));
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let reacquiring: Promise<SessionMcpRuntimeLease> | undefined;
    try {
      const overflow = manager.acquire(input("overflow"));
      await closing.started;
      await vi.advanceTimersByTimeAsync(5_000);
      leases.push(await overflow);
      expect(manager.peekSession({ sessionId: "slow-owner" })).toBeUndefined();
      reacquiring = manager.acquire(input("slow-owner"));
      await vi.advanceTimersByTimeAsync(0);
      expect(factory.mock.calls.filter(([entry]) => entry.sessionId === "slow-owner")).toHaveLength(
        1,
      );
      closing.release();
      const replacement = await reacquiring;
      leases.push(replacement);
      expect(replacement.runtime).not.toBe(original);
      expect(factory.mock.calls.filter(([entry]) => entry.sessionId === "slow-owner")).toHaveLength(
        2,
      );
    } finally {
      closing.release();
      if (reacquiring) {
        (await reacquiring).releaseLease();
      }
      leases.forEach((lease) => lease.releaseLease());
      vi.useRealTimers();
    }
  });

  it("counts requester creation and physical cleanup until closure completes", async () => {
    const held = holdFactory();
    const catalog = await makeRuntime({
      sessionId: "bounded-0",
      requesterSenderId: "sender",
    }).getCatalog();
    const factory = vi.fn<CreateSessionMcpRuntime>((input) =>
      Object.assign(createRuntimeFixture(input), { getCatalog: async () => catalog }),
    );
    const manager = createManager(factory);
    const leases: RequesterScopedMcpRuntimeHandle[] = [];
    await withRequesterResolver(async () => {
      for (let index = 0; index < 255; index += 1) {
        leases.push(
          (await manager.acquireRequesterScoped({
            ...requesterParams("sender"),
            sessionId: `bounded-${index}`,
          }))!,
        );
      }
      manager.rememberAdvertisedScopedCatalog(leases[0]!, await leases[0]!.runtime.getCatalog());
      factory.mockImplementationOnce(held.createRuntime);
      const pending = manager.acquireRequesterScoped({
        ...requesterParams("sender"),
        sessionId: "last",
      });
      await held.started;
      const overflow = (await manager.acquireRequesterScoped({
        ...requesterParams("other-sender"),
        sessionId: "bounded-0",
      }))!;
      expect((await overflow.runtime.getCatalog()).tools).toEqual([]);
      expect(manager.getAdvertisedScopedCatalog("bounded-0")?.tools).toEqual(catalog.tools);
      overflow.releaseLease();
      held.release();
      const last = (await pending)!;
      leases.push(last);
      const closing = holdDisposal(leases[0]!.runtime);
      leases[0]!.releaseLease();
      const admission = manager.acquireRequesterScoped({
        ...requesterParams("sender"),
        sessionId: "admitted",
      });
      await closing.started;
      expect(factory).toHaveBeenCalledTimes(256);
      closing.release();
      leases.push((await admission)!);
      expect(factory).toHaveBeenCalledTimes(257);
      expect(manager.getAdvertisedScopedCatalog("bounded-0")?.tools).toEqual(catalog.tools);
      leases.forEach((lease) => lease.releaseLease());
    });
  });

  it("tries the next idle runtime when LRU cleanup cannot confirm closure", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const manager = createManager(createRuntimeFixture);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const input = (sessionId: string) => ({ ...params, sessionId, cfg });
    const leases = [];
    try {
      const uncertain = await manager.getOrCreate(input("uncertain"));
      uncertain.joinCleanup = async () => {
        throw new Error("child cleanup uncertain");
      };
      const healthy = await manager.getOrCreate(input("healthy"));
      for (let index = 0; index < 254; index += 1) {
        leases.push(await manager.acquire(input(`busy-${index}`)));
      }
      const admitted = await manager.acquire(input("admitted"));
      leases.push(admitted);
      expect(uncertain.dispose).toHaveBeenCalledOnce();
      expect(healthy.dispose).toHaveBeenCalledOnce();
      expect(manager.peekSession({ sessionId: "admitted" })).toBe(admitted.runtime);
      const blocked = await manager.getOrCreate(input("blocked"));
      expect((await blocked.getCatalog()).diagnostics?.[0]?.message).toContain(
        "all 256 Gateway MCP runtimes are in use",
      );
    } finally {
      leases.forEach((lease) => lease.releaseLease());
      clock.mockRestore();
    }
  });

  it("joins an unpublished disposal and reports its failure in the joining caller", async () => {
    const manager = createManager(createRuntimeFixture);
    const runtime = await manager.getOrCreate(params);
    const closing = holdDisposal(runtime);
    runtime.joinCleanup = async () => {
      throw new Error("cleanup owner lost");
    };
    const first = manager.disposeSession(params.sessionId);
    await closing.started;
    const cleanupScope = createAgentCleanupScope();
    let joined = false;
    const second = cleanupScope.run(() =>
      manager.disposeSession(params.sessionId).then(() => {
        joined = true;
      }),
    );
    await nextTurn();
    expect(joined).toBe(false);
    closing.release();
    await Promise.all([first, second]);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(cleanupScope.outcome).toBe("uncertain");
    expect(manager.listRuntimeKeys()).toEqual([]);
    await expect(
      manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {}),
    ).rejects.toThrow("cleanup owner lost");

    const otherSession = "unrelated-session";
    await manager.getOrCreate({ ...params, sessionId: otherSession });
    const targetedScope = createAgentCleanupScope();
    await targetedScope.run(() => manager.disposeSession(otherSession));
    expect(targetedScope.outcome).toBe("closed");
    await manager.retireSessionForAgentDeletion(otherSession, "test", () => {});

    for (let attempt = 0; attempt < 2; attempt++) {
      const laterScope = createAgentCleanupScope();
      await laterScope.run(() => manager.disposeAll());
      expect(laterScope.outcome).toBe("uncertain");
    }
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it("preserves live MCP leases and rechecks deletion authority after admitted work", async () => {
    const held = holdFactory();
    const manager = createManager(held.createRuntime);
    const acquiring = manager.acquire(params);
    const runtime = await held.started;
    let current = true;
    const retiring = manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {
      if (!current) {
        throw new Error("deletion replaced");
      }
    });
    current = false;
    held.release();
    const lease = await acquiring;
    try {
      await expect(retiring).rejects.toThrow("deletion replaced");
      expect(runtime.dispose).not.toHaveBeenCalled();
      await expect(
        manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {}),
      ).rejects.toThrow("active MCP leases");
      expect(runtime.dispose).not.toHaveBeenCalled();
    } finally {
      lease.releaseLease();
    }
    const closing = holdDisposal(runtime);
    const released = manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {});
    await awaitGateBeforeSettlement(closing.started, released, "MCP retirement skipped disposal");
    expect(runtime.dispose).toHaveBeenCalledOnce();
    closing.release();
    await released;
    expect(manager.listRuntimeKeys()).toEqual([]);
  });

  it("preserves a captured session id rebound to another agent without arming retirement", async () => {
    const held = holdFactory();
    const manager = createManager(held.createRuntime);
    const acquiring = manager.acquire({ ...params, sessionKey: "agent:keeper:rebound" });
    const runtime = await held.started;
    const retiring = manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {});
    held.release();
    const lease = await acquiring;
    await retiring;
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(runtime.mcpAppModelContextRevoked).not.toBe(true);
    lease.releaseLease();
    await expect(manager.completeDeferredRetirement(params.sessionId)).resolves.toBe(false);
    expect(manager.peekSession({ sessionId: params.sessionId })).toBe(runtime);
  });

  it("constructs and retires an empty manager without binding or importing transports", async () => {
    const manager = createManager();

    expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
    expect(manager.deferRetirement(params.sessionId)).toBe(false);
    await expect(manager.completeDeferredRetirement(params.sessionId)).resolves.toBe(false);
    await manager.disposeSession(params.sessionId);
    await manager.disposeAll();

    expect(manager.listRuntimeKeys()).toEqual([]);
  });

  it("expires idle requester runtimes outside requesting turns across scheduler replacement and disposal", async () => {
    await withRequesterResolver(async () => {
      const turnContext = new AsyncLocalStorage<string>();
      const pendingInputContext = new AsyncLocalStorage<string>();
      const readContext = () => ({
        turn: turnContext.getStore(),
        pendingInput: pendingInputContext.getStore(),
      });
      const sweepContexts: ReturnType<typeof readContext>[] = [];
      const factoryContexts: ReturnType<typeof readContext>[] = [];
      const clock = createGatewaySchedulerClock(Date.now());
      const previousClock = createGatewaySchedulerClock(clock.clock.now());
      const manager = createManager((input) => {
        factoryContexts.push(readContext());
        const runtime = createRuntimeFixture(input);
        runtime.dispose = vi.fn(async () => {
          sweepContexts.push(readContext());
        });
        return runtime;
      }, createTestGatewayScheduler(previousClock.clock));

      for (const turn of ["first turn", "later turn"]) {
        const pendingInput = `${turn} input`;
        await turnContext.run(turn, () =>
          pendingInputContext.run(pendingInput, async () => {
            const input = requesterParams("sender");
            await manager.getOrCreateRequesterScoped({
              ...input,
              cfg: { mcp: { ...input.cfg.mcp, sessionIdleTtlMs: 600_000 } },
            });
            await manager.setScheduler(createTestGatewayScheduler(clock.clock));
            expect(readContext()).toEqual({ turn, pendingInput });
          }),
        );
        expect(factoryContexts.splice(0)).toEqual([{ turn, pendingInput }]);
        expect(previousClock.armedAtMs).toBeNull();
        await clock.advanceBy(1_200_000);
        expect(sweepContexts.splice(0)).toEqual([{ turn: undefined, pendingInput: undefined }]);
        expect(manager.listRuntimeKeys()).toEqual([]);
        expect(clock.armedAtMs).toBeNull();
        await manager.disposeAll();
      }
    });
  });

  it("resumes CLI acquisition after explicit scheduler binding and Gateway disposal", async () => {
    const standaloneClock = createGatewaySchedulerClock(Date.now());
    const gatewayClock = createGatewaySchedulerClock(standaloneClock.clock.now());
    const standaloneScheduler = createTestGatewayScheduler(standaloneClock.clock);
    const gatewayScheduler = createTestGatewayScheduler(gatewayClock.clock);
    const manager = createManager(createRuntimeFixture, gatewayScheduler);
    const input = idleParams;
    try {
      await manager.setScheduler(gatewayScheduler);
      const gatewayRuntime = await manager.getOrCreate(input);
      await gatewayScheduler.stop();
      await standaloneClock.advanceBy(120_000);
      expect(gatewayRuntime.dispose).not.toHaveBeenCalled();

      await manager.disposeAll();
      expect(gatewayRuntime.dispose).toHaveBeenCalledOnce();
      await manager.setScheduler(standaloneScheduler);
      const standaloneRuntime = await manager.getOrCreate({ ...input, sessionId: "cli-session" });
      await standaloneClock.advanceBy(60_000);
      expect(standaloneRuntime.dispose).toHaveBeenCalledOnce();
      expect(manager.listRuntimeKeys()).toEqual([]);
    } finally {
      await Promise.all([standaloneScheduler.stop(), gatewayScheduler.stop()]);
    }
  });

  it("joins running idle cleanup before scheduler handoff with disabled cadence", async () => {
    const firstClock = createGatewaySchedulerClock(Date.now());
    const secondClock = createGatewaySchedulerClock(firstClock.clock.now());
    const firstScheduler = createTestGatewayScheduler(firstClock.clock);
    const secondScheduler = createTestGatewayScheduler(secondClock.clock);
    const manager = createManager(createRuntimeFixture, firstScheduler);
    const input = idleParams;
    const runtime = await manager.getOrCreate(input);
    const cleanup = holdDisposal(runtime);
    const sweep = firstClock.advanceBy(120_000);
    await cleanup.started;
    await manager.getOrCreate({
      ...params,
      sessionId: "idle-disabled",
      cfg: { mcp: { sessionIdleTtlMs: 0, servers: {} } },
    });
    const handoff = manager.setScheduler(secondScheduler);
    try {
      const next = await manager.getOrCreate({ ...input, sessionId: "later-session" });
      expect(secondScheduler.nextWakeAtMs).toBeNull();
      cleanup.release();
      await Promise.all([sweep, handoff]);
      await secondClock.advanceBy(120_000);
      expect(next.dispose).toHaveBeenCalledOnce();
      expect(manager.listRuntimeKeys()).toEqual(["idle-disabled"]);
    } finally {
      cleanup.release();
      await Promise.all([sweep, handoff]);
      await Promise.all([firstScheduler.stop(), secondScheduler.stop()]);
    }
  });

  it.each(
    ["host-close", "scheduler-stop", "already-stopped", "unbound-stopped"].flatMap((boundary) => [
      { boundary, entrypoint: "full", acquire: acquireSessionMcpRuntime },
      { boundary, entrypoint: "requester", acquire: acquireRequesterScopedMcpRuntime },
    ]),
  )("rejects acquisition at $boundary ($entrypoint)", async ({ boundary, acquire }) => {
    const firstClock = createGatewaySchedulerClock(Date.now());
    const firstScheduler = createTestGatewayScheduler(firstClock.clock);
    const nextScheduler = createTestGatewayScheduler();
    const manager = createManager(createRuntimeFixture, firstScheduler);
    const input = idleParams;
    const runtime = await manager.getOrCreate(input);
    const cleanup = holdDisposal(runtime);
    const sweep = firstClock.advanceBy(120_000);
    await cleanup.started;
    const restoreManager = bindManager(manager);
    const host = new LegacyPluginSdkResourceHost();
    host.bindScheduler(nextScheduler);
    if (boundary === "already-stopped") {
      await nextScheduler.stop();
    } else if (boundary === "unbound-stopped") {
      firstScheduler.beginClose();
    }
    const run = () => acquire({ ...input, sessionId: "closed-cli-session" });
    const acquisition = boundary === "unbound-stopped" ? run() : host.run(run);
    const refused =
      boundary === "host-close"
        ? expect(acquisition).rejects.toThrow("Plugin SDK resource host is closed")
        : expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
    try {
      if (boundary === "host-close") {
        await host.close();
      } else if (boundary === "scheduler-stop") {
        await nextScheduler.stop();
      }
      cleanup.release();
      await Promise.all([sweep, refused]);
      expect(manager.listRuntimeKeys()).toEqual([]);
    } finally {
      cleanup.release();
      await Promise.allSettled([sweep, acquisition]);
      await host.close();
      await Promise.all([firstScheduler.stop(), nextScheduler.stop()]);
      restoreManager();
    }
  });

  it.each(
    ["host-close", "scheduler-stop", "last-scheduler-stop", "unbound-last-scheduler-stop"].flatMap(
      (boundary) => [
        { boundary, entrypoint: "full", acquire: acquireSessionMcpRuntime },
        { boundary, entrypoint: "requester", acquire: acquireRequesterScopedMcpRuntime },
      ],
    ),
  )("releases queued acquisition after $boundary ($entrypoint)", async ({ boundary, acquire }) => {
    await withRequesterResolver(async () => {
      const survivorScheduler = createTestGatewayScheduler();
      const originScheduler = createTestGatewayScheduler();
      const survivorHost = new LegacyPluginSdkResourceHost();
      survivorHost.bindScheduler(survivorScheduler);
      const originHost = new LegacyPluginSdkResourceHost();
      originHost.bindScheduler(originScheduler);
      const held = holdFactory();
      const manager = createManager(held.createRuntime, survivorScheduler);
      const restoreManager = bindManager(manager);
      const input =
        acquire === acquireRequesterScopedMcpRuntime ? requesterParams("sender") : params;
      const acquisition =
        boundary === "unbound-last-scheduler-stop"
          ? acquire(input)
          : originHost.run(() => acquire(input));
      let rejectionSettled = false;
      const refused = (
        boundary === "host-close"
          ? expect(acquisition).rejects.toThrow("Plugin SDK resource host is closed")
          : expect(acquisition).rejects.toMatchObject({ name: "AbortError" })
      ).finally(() => {
        rejectionSettled = true;
      });
      const runtime = await held.started;
      const closing = boundary.endsWith("last-scheduler-stop") ? holdDisposal(runtime) : undefined;
      const surviving = closing ? undefined : survivorHost.run(() => acquire(input));
      let peer: Awaited<typeof surviving>;
      try {
        if (closing) {
          await survivorScheduler.stop();
        }
        if (boundary === "host-close") {
          await originHost.close();
        } else {
          await originScheduler.stop();
        }
        held.release();
        if (closing) {
          await Promise.race([closing.started, acquisition]);
          expect(runtime.activeLeases).toBe(0);
          expect(rejectionSettled).toBe(false);
          closing.release();
        }
        await refused;
        peer = await surviving;
        if (closing) {
          expect(runtime.dispose).toHaveBeenCalledOnce();
          expect(manager.listRuntimeKeys()).toEqual([]);
        } else {
          expect(peer?.runtime).toBe(runtime);
          expect(runtime.activeLeases).toBe(1);
          expect(runtime.dispose).not.toHaveBeenCalled();
          expect(survivorScheduler.signal.aborted).toBe(false);
        }
      } finally {
        held.release();
        closing?.release();
        await Promise.allSettled([acquisition, surviving]);
        peer ??= await surviving?.catch(() => undefined);
        peer?.releaseLease();
        await Promise.all([originHost.close(), survivorHost.close()]);
        await Promise.all([originScheduler.stop(), survivorScheduler.stop()]);
        restoreManager();
      }
    });
  });

  it.each([
    { scope: "session", kind: "static", replacement: undefined },
    { scope: "all", kind: "static", replacement: undefined },
    { scope: "all", kind: "requester", replacement: undefined },
    { scope: undefined, kind: "static", replacement: "config" },
    { scope: undefined, kind: "static", replacement: "workspace" },
  ] as const)(
    "serializes $kind successors after $scope teardown / $replacement replacement",
    async ({ scope, kind, replacement }) => {
      await withRequesterResolver(async () => {
        const first = holdFactory();
        const next = holdFactory();
        const createRuntime = vi
          .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
          .mockImplementationOnce(
            replacement === "config" ? createRuntimeFixture : first.createRuntime,
          )
          .mockImplementationOnce(next.createRuntime);
        const manager = createManager(createRuntime);
        const changed =
          replacement === "config"
            ? { ...params, cfg: { mcp: { apps: { enabled: true }, servers: {} } } }
            : { ...params, workspaceDir: "/replacement-workspace" };
        const acquire = async (updated = false) =>
          kind === "requester"
            ? expectDefined(
                await manager.getOrCreateRequesterScoped(requesterParams("sender")),
                "requester runtime",
              ).runtime
            : manager.getOrCreate(updated && replacement ? changed : params);
        const oldRequest = acquire();
        const oldRuntime = await (replacement === "config" ? oldRequest : first.started);
        const closing = replacement === "workspace" ? undefined : holdDisposal(oldRuntime);
        let drained = false;
        const disposal = scope
          ? (scope === "session"
              ? manager.disposeSession(params.sessionId)
              : manager.disposeAll()
            ).then(() => {
              drained = true;
            })
          : undefined;
        const nextRequest = acquire(true);
        if (replacement === "config") {
          await closing!.started;
        }
        const earlyConcurrent = replacement ? acquire(true) : undefined;
        if (replacement) {
          await manager.sweepIdleRuntimes();
          expect(createRuntime).toHaveBeenCalledOnce();
        }
        first.release();
        if (scope) {
          await closing!.started;
          expect(drained).toBe(false);
          expect(createRuntime).toHaveBeenCalledOnce();
          expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
        }
        closing?.release();
        await disposal;
        const nextRuntime = await next.started;
        expect(await oldRequest).toBe(oldRuntime);
        expect(oldRuntime.dispose).toHaveBeenCalledOnce();
        if (replacement) {
          expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
        }
        const concurrentRequest = earlyConcurrent ?? acquire();
        next.release();
        const [created, concurrent] = await Promise.all([nextRequest, concurrentRequest]);
        expect(created).toBe(nextRuntime);
        expect(concurrent).toBe(nextRuntime);
        expect(createRuntime).toHaveBeenCalledTimes(2);
        if (!scope) {
          return;
        }
        if (kind === "static") {
          expect(manager.peekSession({ sessionKey: params.sessionKey })).toBe(nextRuntime);
        }
        expect(nextRuntime.dispose).not.toHaveBeenCalled();
        expect(manager.listSessionIds()).toEqual([params.sessionId]);
        expect(manager.resolveSessionId(params.sessionKey)).toBe(params.sessionId);
        await expect(acquire()).resolves.toBe(nextRuntime);
        await manager.disposeAll();
        expect(nextRuntime.dispose).toHaveBeenCalledOnce();
        const subsequent = await acquire();
        expect(subsequent).not.toBe(nextRuntime);
        if (kind === "static") {
          expect(manager.peekSession({ sessionId: params.sessionId })).toBe(subsequent);
        }
      });
    },
  );

  it.each(["session", "all"] as const)(
    "drains the requester partition of a pending full acquisition during %s disposal",
    async (scope) => {
      const resolutionStarted = createDeferred();
      const releaseResolution = createDeferred();
      releaseHeldWork.push(() => releaseResolution.resolve());
      await withRequesterResolver(
        async () => {
          const first = holdFactory();
          const created: SessionMcpRuntime[] = [];
          const manager = createManager(async (input) => {
            const runtime = created.length
              ? createRuntimeFixture(input)
              : await first.createRuntime(input);
            created.push(runtime);
            return runtime;
          });
          const pending = manager.acquire(requesterParams("sender"));
          await first.started;
          let drained = false;
          const disposal = (
            scope === "session" ? manager.disposeSession(params.sessionId) : manager.disposeAll()
          ).then(() => {
            drained = true;
          });
          first.release();
          await resolutionStarted.promise;
          await nextTurn();
          expect(drained).toBe(false);
          releaseResolution.resolve();
          const acquired = await pending;
          acquired.releaseLease();
          await disposal;
          expect(created).toHaveLength(2);
          for (const runtime of created) {
            expect(runtime.dispose).toHaveBeenCalledOnce();
          }
          expect(manager.listRuntimeKeys()).toEqual([]);
          expect(manager.resolveSessionId(params.sessionKey)).toBeUndefined();
        },
        async () => {
          resolutionStarted.resolve();
          await releaseResolution.promise;
          return { url: "https://mcp.example.test/scoped" };
        },
      );
    },
  );

  it.each(["session", "all"] as const)(
    "queues a new requester key behind %s teardown",
    async (scope) => {
      await withRequesterResolver(async () => {
        const createRuntime = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
        const manager = createManager(createRuntime);
        const old = expectDefined(
          await manager.acquireRequesterScoped(requesterParams("first")),
          "first requester",
        );
        old.releaseLease();
        const closing = holdDisposal(old.runtime);
        const disposal =
          scope === "session" ? manager.disposeSession(params.sessionId) : manager.disposeAll();
        await closing.started;
        const next = manager.acquireRequesterScoped({
          ...requesterParams("next"),
          ...(scope === "all" ? { sessionId: "another-session", sessionKey: "another-key" } : {}),
        });
        await nextTurn();
        expect(createRuntime).toHaveBeenCalledOnce();
        closing.release();
        await disposal;
        const acquired = expectDefined(await next, "next requester");
        acquired.releaseLease();
        expect(acquired.runtime.dispose).not.toHaveBeenCalled();
        expect(manager.listSessionIds()).toEqual([acquired.runtime.sessionId]);
      });
    },
  );

  it("keeps required retirement armed across delayed creation and reuse", async () => {
    const held = holdFactory();
    const manager = createManager(held.createRuntime);
    const creating = manager.getOrCreate(params);
    const runtime = await held.started;
    manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
    manager.deferRetirement(params.sessionId);
    held.release();
    await creating;
    const release = expectDefined(runtime.acquireLease, "fixture runtime lease")();

    expect(runtime.mcpAppModelContextRevoked).toBe(true);
    await expect(manager.getOrCreate(params)).resolves.toBe(runtime);
    await expect(manager.completeDeferredRetirement(params.sessionId, runtime)).resolves.toBe(
      false,
    );
    release();
    await expect(manager.completeDeferredRetirement(params.sessionId, runtime)).resolves.toBe(true);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(manager.listRuntimeKeys()).toEqual([]);
  });
});
