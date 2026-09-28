import { AsyncLocalStorage } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  acquireRequesterScopedMcpRuntime,
  acquireSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-api.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import type { SessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import {
  SESSION_MCP_RUNTIME_MANAGER_KEY,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
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

function createRuntimeFixture(input: Parameters<CreateSessionMcpRuntime>[0]): SessionMcpRuntime {
  let lastUsedAt = Date.now();
  let activeLeases = 0;
  return {
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    workspaceDir: input.workspaceDir,
    agentDir: input.agentDir,
    requesterScope: input.requesterScope,
    configFingerprint: input.configFingerprint ?? "fixture",
    createdAt: lastUsedAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease() {
      activeLeases += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          activeLeases -= 1;
        }
      };
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    getCatalog: async () => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }),
    peekCatalog: () => null,
    callTool: async () => ({ content: [] }),
    joinCleanup: async () => {},
    dispose: vi.fn(async () => {}),
  };
}

function createManager(createRuntime?: CreateSessionMcpRuntime) {
  const manager = createSessionMcpRuntimeManager({ createRuntime, enableIdleSweepTimer: false });
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
  it("keeps serverless sessions available beyond the MCP limit and while it is full", async () => {
    const manager = createManager(createRuntimeFixture);
    for (let index = 0; index < 300; index += 1) {
      await manager.getOrCreate({ ...params, sessionId: `serverless-${index}` });
    }
    const configured = { mcp: { servers: { fixture: { command: "true" } } } };
    for (let index = 0; index < 256; index += 1) {
      await manager.getOrCreate({ ...params, sessionId: `connected-${index}`, cfg: configured });
    }
    await manager.getOrCreate({ ...params, sessionId: "serverless-at-capacity" });
    await expect(
      manager.getOrCreate({ ...params, sessionId: "connected-overflow", cfg: configured }),
    ).rejects.toThrow("live runtime limit (256)");
    await expect(
      manager.getOrCreate({ ...params, sessionId: "serverless-0", cfg: configured }),
    ).rejects.toThrow("live runtime limit (256)");
    await manager.getOrCreate({ ...params, sessionId: "connected-0" });
    await manager.getOrCreate({ ...params, sessionId: "serverless-0", cfg: configured });
  });

  it.each(["static", "requester"] as const)(
    "bounds %s runtimes across sessions, creation, and cleanup",
    async (kind) => {
      const held = holdFactory();
      const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
      const manager = createManager(factory);
      const acquire = (sessionId: string) =>
        kind === "static"
          ? manager.getOrCreate({
              ...params,
              sessionId,
              cfg: { mcp: { servers: { fixture: { command: "true" } } } },
            })
          : manager.getOrCreateRequesterScoped({ ...requesterParams("sender"), sessionId });
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
        resolverRegistry.apiFor("test-plugin").registerMcpServerConnectionResolver({
          serverName: "scoped",
          resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
        });
        for (let index = 0; index < 255; index += 1) {
          await acquire(`bounded-${index}`);
        }
        factory.mockImplementationOnce(held.createRuntime);
        const last = acquire("last-slot");
        await held.started;
        await expect(acquire("overflow")).rejects.toThrow("live runtime limit (256)");
        held.release();
        await last;
        const firstKey = expectDefined(
          manager
            .listRuntimeKeys()
            .find((key) => key === "bounded-0" || key.includes('"sessionId":"bounded-0"')),
          "first runtime key",
        );
        const first = expectDefined(manager.peekSession({ sessionId: firstKey }), "first runtime");
        await acquire("bounded-0");
        expect(first.dispose).not.toHaveBeenCalled();
        const closing = holdDisposal(first);
        const disposal = manager.disposeSession("bounded-0");
        await closing.started;
        await expect(acquire("overflow")).rejects.toThrow("live runtime limit (256)");
        closing.release();
        await disposal;
        await acquire("overflow");
        expect(manager.listRuntimeKeys()).toHaveLength(256);
        await manager.disposeAll();
        await acquire("after-shutdown");
        expect(manager.listSessionIds()).toEqual(["after-shutdown"]);
      });
    },
  );

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
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(joined).toBe(false);
    closing.release();
    await Promise.all([first, second]);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(cleanupScope.outcome).toBe("uncertain");
    expect(manager.listRuntimeKeys()).toEqual([]);
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

  it.each(["static", "requester"] as const)(
    "expires idle %s runtimes outside requesting turns across scheduler replacement and disposal",
    async (entrypoint) => {
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
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
        const manager = createSessionMcpRuntimeManager({
          scheduler: createTestGatewayScheduler(previousClock.clock),
          createRuntime(input) {
            factoryContexts.push(readContext());
            const runtime = createRuntimeFixture(input);
            runtime.dispose = vi.fn(async () => {
              sweepContexts.push(readContext());
            });
            return runtime;
          },
        });
        managers.push(manager);
        const resolverApi = resolverRegistry.apiFor("test-plugin");
        resolverApi.registerMcpServerConnectionResolver({
          serverName: "scoped",
          resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
        });

        try {
          for (const turn of ["first turn", "later turn"]) {
            const pendingInput = `${turn} input`;
            await turnContext.run(turn, () =>
              pendingInputContext.run(pendingInput, async () => {
                if (entrypoint === "static") {
                  await manager.getOrCreate({
                    ...params,
                    cfg: { mcp: { sessionIdleTtlMs: 600_000, servers: {} } },
                  });
                } else {
                  await manager.getOrCreateRequesterScoped({
                    ...params,
                    requesterSenderId: "sender",
                    cfg: {
                      mcp: {
                        sessionIdleTtlMs: 600_000,
                        servers: { scoped: { transport: "streamable-http" } },
                      },
                    },
                  });
                }
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
        } finally {
          await manager.disposeAll();
        }
      });
    },
  );

  it("keeps idle reclamation on the surviving Gateway when the latest scheduler closes", async () => {
    const firstClock = createGatewaySchedulerClock(Date.now());
    const secondClock = createGatewaySchedulerClock(firstClock.clock.now());
    const firstScheduler = createTestGatewayScheduler(firstClock.clock);
    const secondScheduler = createTestGatewayScheduler(secondClock.clock);
    const manager = createSessionMcpRuntimeManager({
      scheduler: firstScheduler,
      createRuntime: createRuntimeFixture,
    });
    managers.push(manager);
    const lease = await manager.acquire({
      ...params,
      cfg: { mcp: { sessionIdleTtlMs: 60_000, servers: {} } },
    });
    try {
      await manager.setScheduler(secondScheduler);
      await secondScheduler.stop();
      await firstClock.advanceBy(120_000);
      expect(lease.runtime.dispose).not.toHaveBeenCalled();

      lease.releaseLease();
      await firstClock.advanceBy(60_000);
      expect(lease.runtime.dispose).toHaveBeenCalledOnce();
      expect(manager.listRuntimeKeys()).toEqual([]);
    } finally {
      lease.releaseLease();
      await Promise.all([firstScheduler.stop(), secondScheduler.stop()]);
    }
  });

  it("resumes CLI acquisition after explicit scheduler binding and Gateway disposal", async () => {
    const standaloneClock = createGatewaySchedulerClock(Date.now());
    const gatewayClock = createGatewaySchedulerClock(standaloneClock.clock.now());
    const standaloneScheduler = createTestGatewayScheduler(standaloneClock.clock);
    const gatewayScheduler = createTestGatewayScheduler(gatewayClock.clock);
    const manager = createSessionMcpRuntimeManager({
      scheduler: gatewayScheduler,
      createRuntime: createRuntimeFixture,
    });
    managers.push(manager);
    const input = { ...params, cfg: { mcp: { sessionIdleTtlMs: 60_000, servers: {} } } };
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

  it("joins running idle cleanup before arming the successor scheduler", async () => {
    const firstClock = createGatewaySchedulerClock(Date.now());
    const secondClock = createGatewaySchedulerClock(firstClock.clock.now());
    const firstScheduler = createTestGatewayScheduler(firstClock.clock);
    const secondScheduler = createTestGatewayScheduler(secondClock.clock);
    const manager = createSessionMcpRuntimeManager({
      scheduler: firstScheduler,
      createRuntime: createRuntimeFixture,
    });
    managers.push(manager);
    const input = { ...params, cfg: { mcp: { sessionIdleTtlMs: 60_000, servers: {} } } };
    const runtime = await manager.getOrCreate(input);
    const cleanup = holdDisposal(runtime);
    const sweep = firstClock.advanceBy(120_000);
    await cleanup.started;
    const handoff = manager.setScheduler(secondScheduler);
    try {
      const next = await manager.getOrCreate({ ...input, sessionId: "later-session" });
      expect(secondScheduler.nextWakeAtMs).toBeNull();
      cleanup.release();
      await Promise.all([sweep, handoff]);
      await secondClock.advanceBy(120_000);
      expect(next.dispose).toHaveBeenCalledOnce();
      expect(manager.listRuntimeKeys()).toEqual([]);
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
  )("rejects $entrypoint acquisition at $boundary", async ({ boundary, acquire }) => {
    const firstClock = createGatewaySchedulerClock(Date.now());
    const firstScheduler = createTestGatewayScheduler(firstClock.clock);
    const nextScheduler = createTestGatewayScheduler();
    const manager = createSessionMcpRuntimeManager({
      scheduler: firstScheduler,
      createRuntime: createRuntimeFixture,
    });
    managers.push(manager);
    const input = { ...params, cfg: { mcp: { sessionIdleTtlMs: 60_000, servers: {} } } };
    const runtime = await manager.getOrCreate(input);
    const cleanup = holdDisposal(runtime);
    const sweep = firstClock.advanceBy(120_000);
    await cleanup.started;
    const previous = Reflect.get(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
    const hadManager = Reflect.has(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
    Reflect.set(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, manager);
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
      if (hadManager) {
        Reflect.set(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, previous);
      } else {
        Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
      }
    }
  });

  it.each(
    ["host-close", "scheduler-stop", "last-scheduler-stop", "unbound-last-scheduler-stop"].flatMap(
      (boundary) => [
        { boundary, entrypoint: "full", acquire: acquireSessionMcpRuntime },
        { boundary, entrypoint: "requester", acquire: acquireRequesterScopedMcpRuntime },
      ],
    ),
  )(
    "releases queued $entrypoint acquisition after $boundary",
    async ({ boundary, entrypoint, acquire }) => {
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
        resolverRegistry.apiFor("test-plugin").registerMcpServerConnectionResolver({
          serverName: "scoped",
          resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
        });
        const survivorScheduler = createTestGatewayScheduler();
        const originScheduler = createTestGatewayScheduler();
        const survivorHost = new LegacyPluginSdkResourceHost();
        survivorHost.bindScheduler(survivorScheduler);
        const originHost = new LegacyPluginSdkResourceHost();
        originHost.bindScheduler(originScheduler);
        const held = holdFactory();
        const manager = createSessionMcpRuntimeManager({
          scheduler: survivorScheduler,
          createRuntime: held.createRuntime,
          enableIdleSweepTimer: false,
        });
        managers.push(manager);
        const previous = Reflect.get(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
        const hadManager = Reflect.has(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
        Reflect.set(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, manager);
        const input = entrypoint === "requester" ? requesterParams("sender") : params;
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
        const closing = boundary.endsWith("last-scheduler-stop")
          ? holdDisposal(runtime)
          : undefined;
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
          if (hadManager) {
            Reflect.set(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, previous);
          } else {
            Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
          }
        }
      });
    },
  );

  it.each(["session", "all"] as const)(
    "drains late creation during %s disposal before admitting a successor",
    async (scope) => {
      const first = holdFactory();
      const next = holdFactory();
      const createRuntime = vi
        .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
        .mockImplementationOnce(first.createRuntime)
        .mockImplementationOnce(next.createRuntime);
      const manager = createManager(createRuntime);
      const oldRequest = manager.getOrCreate(params);
      const oldRuntime = await first.started;
      const closing = holdDisposal(oldRuntime);
      let drained = false;
      const disposal = (
        scope === "session" ? manager.disposeSession(params.sessionId) : manager.disposeAll()
      ).then(() => {
        drained = true;
      });

      const nextRequest = manager.getOrCreate(params);
      first.release();
      await closing.started;
      expect(drained).toBe(false);
      expect(createRuntime).toHaveBeenCalledOnce();
      expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
      closing.release();
      await disposal;
      expect(await oldRequest).toBe(oldRuntime);
      expect(oldRuntime.dispose).toHaveBeenCalledOnce();

      const nextRuntime = await next.started;
      const concurrentRequest = manager.getOrCreate(params);
      next.release();
      const [created, concurrent] = await Promise.all([nextRequest, concurrentRequest]);
      expect(created).toBe(nextRuntime);
      expect(concurrent).toBe(nextRuntime);
      expect(createRuntime).toHaveBeenCalledTimes(2);
      expect(manager.peekSession({ sessionKey: params.sessionKey })).toBe(nextRuntime);
      expect(nextRuntime.dispose).not.toHaveBeenCalled();
      await expect(manager.getOrCreate(params)).resolves.toBe(nextRuntime);

      await manager.disposeAll();
      expect(nextRuntime.dispose).toHaveBeenCalledOnce();
      const subsequent = await manager.getOrCreate(params);
      expect(subsequent).not.toBe(nextRuntime);
      expect(manager.peekSession({ sessionId: params.sessionId })).toBe(subsequent);
    },
  );

  it.each([
    { label: "workspace", update: { workspaceDir: "/other-workspace" } },
    { label: "agent", update: { agentDir: "/agents/other" } },
    { label: "config", update: { cfg: { mcp: { apps: { enabled: true }, servers: {} } } } },
  ])("claims a $label replacement before awaiting old runtime disposal", async ({ update }) => {
    const next = holdFactory();
    const createRuntime = vi
      .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
      .mockImplementationOnce(createRuntimeFixture)
      .mockImplementationOnce(next.createRuntime);
    const manager = createManager(createRuntime);
    const oldRuntime = await manager.getOrCreate(params);
    const closing = holdDisposal(oldRuntime);
    const changed = { ...params, ...update };
    const replacement = manager.getOrCreate(changed);
    await closing.started;
    const concurrent = manager.getOrCreate(changed);
    // Join the public idle-sweep boundary while old disposal remains blocked.
    await manager.sweepIdleRuntimes();
    expect(createRuntime).toHaveBeenCalledOnce();

    closing.release();
    const nextRuntime = await next.started;
    next.release();
    await expect(replacement).resolves.toBe(nextRuntime);
    await expect(concurrent).resolves.toBe(nextRuntime);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(oldRuntime.dispose).toHaveBeenCalledOnce();
  });

  it.each(["session", "all"] as const)(
    "drains the requester partition of a pending full acquisition during %s disposal",
    async (scope) => {
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
        const first = holdFactory();
        const resolutionStarted = createDeferred();
        const releaseResolution = createDeferred();
        releaseHeldWork.push(() => releaseResolution.resolve());
        const resolverApi = resolverRegistry.apiFor("test-plugin");
        resolverApi.registerMcpServerConnectionResolver({
          serverName: "scoped",
          resolve: async () => {
            resolutionStarted.resolve();
            await releaseResolution.promise;
            return { url: "https://mcp.example.test/scoped" };
          },
        });
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
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
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
      });
    },
  );

  it.each(["session", "all"] as const)(
    "queues a new requester key behind %s teardown",
    async (scope) => {
      const resolverRegistry = createMcpProofPluginRegistry();
      await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
        const resolverApi = resolverRegistry.apiFor("test-plugin");
        resolverApi.registerMcpServerConnectionResolver({
          serverName: "scoped",
          resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
        });
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
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
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

  it("serializes a pending factory and reuses its queued replacement", async () => {
    const first = holdFactory();
    const next = holdFactory();
    const createRuntime = vi
      .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
      .mockImplementationOnce(first.createRuntime)
      .mockImplementationOnce(next.createRuntime);
    const manager = createManager(createRuntime);
    const oldRequest = manager.getOrCreate(params);
    const oldRuntime = await first.started;
    const changed = { ...params, workspaceDir: "/replacement-workspace" };
    const replacement = manager.getOrCreate(changed);
    const concurrent = manager.getOrCreate(changed);
    await manager.sweepIdleRuntimes();
    first.release();

    const nextRuntime = await next.started;
    expect(await oldRequest).toBe(oldRuntime);
    expect(oldRuntime.dispose).toHaveBeenCalledOnce();
    expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
    next.release();
    await expect(replacement).resolves.toBe(nextRuntime);
    await expect(concurrent).resolves.toBe(nextRuntime);
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

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

  it("serializes requester replacement behind global disposal instead of clearing its lock", async () => {
    const resolverRegistry = createMcpProofPluginRegistry();
    await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
      const resolverApi = resolverRegistry.apiFor("test-plugin");
      resolverApi.registerMcpServerConnectionResolver({
        serverName: "scoped",
        resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
      });
      const first = holdFactory();
      const next = holdFactory();
      const createRuntime = vi
        .fn<CreateSessionMcpRuntime>(createRuntimeFixture)
        .mockImplementationOnce(first.createRuntime)
        .mockImplementationOnce(next.createRuntime);
      const manager = createManager(createRuntime);
      const scoped = {
        ...params,
        requesterSenderId: "sender",
        cfg: { mcp: { servers: { scoped: { transport: "streamable-http" as const } } } },
      };
      const firstRequest = manager.getOrCreateRequesterScoped(scoped);
      const oldRuntime = await first.started;
      const closing = holdDisposal(oldRuntime);
      const disposal = manager.disposeAll();
      const nextRequest = manager.getOrCreateRequesterScoped(scoped);
      first.release();
      await closing.started;
      expect(createRuntime).toHaveBeenCalledOnce();
      closing.release();
      await disposal;
      await firstRequest;

      const nextRuntime = await next.started;
      next.release();
      expect((await nextRequest)?.runtime).toBe(nextRuntime);
      expect(createRuntime).toHaveBeenCalledTimes(2);
      expect(oldRuntime.dispose).toHaveBeenCalledOnce();
      expect(nextRuntime.dispose).not.toHaveBeenCalled();
      expect(manager.listSessionIds()).toEqual([params.sessionId]);
      expect(manager.resolveSessionId(params.sessionKey)).toBe(params.sessionId);
    });
  });
});
