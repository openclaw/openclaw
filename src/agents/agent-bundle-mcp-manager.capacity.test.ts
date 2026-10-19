import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createSessionMcpRuntimeManager,
  makeRuntime,
} from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
} from "./agent-bundle-mcp-types.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";

const params = {
  sessionId: "static-session",
  sessionKey: "agent:test:static-session",
  agentId: "test",
  workspaceDir: "/workspace",
  agentDir: "/agents/test",
  cfg: { mcp: { servers: { fixture: { command: "true" } } } },
  manifestRegistry: { plugins: [] },
};
const managers: ReturnType<typeof createSessionMcpRuntimeManager>[] = [];
const held: SessionMcpRuntimeLease[] = [];

function setup() {
  const sources = new Map<
    SessionMcpRuntime,
    {
      catalog: McpToolCatalog;
      pending?: Promise<McpToolCatalog>;
    }
  >();
  const factory = vi.fn<CreateSessionMcpRuntime>(async (input) => {
    const serverName = input.requesterScope ? "scoped" : "fixture";
    const runtime = makeRuntime([{ toolName: "echo", description: "Echo a value" }], serverName);
    const source: { catalog: McpToolCatalog; pending?: Promise<McpToolCatalog> } = {
      catalog: await runtime.getCatalog(),
    };
    sources.set(runtime, source);
    let activeLeases = 0;
    Object.defineProperty(runtime, "activeLeases", { get: () => activeLeases });
    return Object.assign(runtime, {
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      workspaceDir: input.workspaceDir,
      agentDir: input.agentDir,
      configFingerprint: input.configFingerprint ?? "fixture",
      requesterScope: input.requesterScope,
      acquireLease() {
        activeLeases++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            activeLeases--;
          }
        };
      },
      getCatalog: () => source.pending ?? Promise.resolve(source.catalog),
      peekCatalog: () => null,
      callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "live echo" }] })),
      dispose: vi.fn(async () => {}),
    });
  });
  const manager = createSessionMcpRuntimeManager({ createRuntime: factory });
  managers.push(manager);
  const fill = async (count = 256) => {
    for (let index = 0; index < count; index++) {
      held.push(
        await manager.acquire({ ...params, sessionId: `busy-${index}`, sessionKey: undefined }),
      );
    }
  };
  return { manager, factory, sources, fill };
}

async function withRequester(run: () => Promise<void>) {
  const registry = createMcpProofPluginRegistry();
  return withPluginRuntimeRegistryScope(registry.registry, async () => {
    registry.apiFor("test-plugin").registerMcpServerConnectionResolver({
      serverName: "scoped",
      resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
    });
    await run();
  });
}

const mixedParams = {
  ...params,
  requesterSenderId: "alice",
  cfg: {
    mcp: {
      servers: {
        fixture: { command: "true" },
        scoped: { transport: "streamable-http" as const },
      },
    },
  },
};

beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));

afterEach(async () => {
  for (const lease of held.splice(0)) {
    lease.releaseLease();
  }
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  vi.useRealTimers();
});

describe("MCP capacity catalog continuity", () => {
  it.each(["full", "requester"])(
    "evicts the idle requester LRU during an active shared-session turn through %s acquisition",
    async (scope) => {
      await withRequester(async () => {
        const { manager } = setup();
        const input = (index: number) => ({
          ...mixedParams,
          requesterSenderId: `sender-${index}`,
          cfg: { mcp: { servers: { scoped: { transport: "streamable-http" as const } } } },
        });
        const runtimes: SessionMcpRuntime[] = [];
        for (let index = 0; index < 256; index++) {
          vi.setSystemTime(index);
          const lease = (await manager.acquireRequesterScoped(input(index)))!;
          runtimes.push(lease.runtime);
          lease.releaseLease();
        }
        vi.setSystemTime(256);
        const refreshed = (await manager.acquireRequesterScoped(input(0)))!;
        refreshed.releaseLease();
        const claim = claimAgentRunContext(
          "mcp-shared-session-turn",
          { sessionId: params.sessionId, sessionKey: params.sessionKey },
          { trackOwner: true, ownsContext: true },
        );
        try {
          const lease =
            scope === "full"
              ? await manager.acquire(input(256))
              : (await manager.acquireRequesterScoped(input(256)))!;
          const tools = await materializeBundleMcpToolsForRun(lease);
          try {
            expect(tools.tools.map((tool) => tool.name)).toEqual(["scoped__echo"]);
            expect((await tools.tools[0]!.execute("new-sender", {})).content).toEqual([
              { type: "text", text: "live echo" },
            ]);
            expect(runtimes[1]!.dispose).toHaveBeenCalledOnce();
            for (const runtime of runtimes.filter((_, index) => index !== 1)) {
              expect(runtime.dispose).not.toHaveBeenCalled();
            }
          } finally {
            await tools.dispose();
          }
        } finally {
          releaseAgentRunContext("mcp-shared-session-turn", claim);
        }
      });
    },
  );

  it("keeps advertised static schemas after eviction even when the current peek is invalidated", async () => {
    const { manager, fill, factory } = setup();
    const firstLease = await manager.acquire(params);
    const first = await materializeBundleMcpToolsForRun(firstLease);
    const surface = first.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    await first.dispose();
    await fill();
    expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
    const refused = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect(
      refused.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ).toEqual(surface);
    const result = await refused.tools[0]!.execute("capacity-call", {});
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("This turn will continue without MCP tools") },
    ]);
    expect(firstLease.runtime.callTool).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(257);
    await refused.dispose();
    held[0]!.releaseLease();
    const recovered = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect((await recovered.tools[0]!.execute("recovered-call", {})).content).toEqual([
      { type: "text", text: "live echo" },
    ]);
    await recovered.dispose();
  });

  it("preserves embedded requester schemas after eviction without contacting MCP", async () => {
    await withRequester(async () => {
      const { manager, fill, factory, sources } = setup();
      const firstLease = await manager.acquire(mixedParams);
      const first = await materializeBundleMcpToolsForRun(firstLease);
      const surface = first.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
      expect(surface.map((tool) => tool.name)).toEqual(["fixture__echo", "scoped__echo"]);
      await first.dispose();
      await fill();
      const creations = factory.mock.calls.length;
      const refused = await materializeBundleMcpToolsForRun(await manager.acquire(mixedParams));
      expect(
        refused.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
      ).toEqual(surface);
      const result = await refused.tools
        .find((tool) => tool.name === "scoped__echo")!
        .execute("refused", {});
      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("This turn will continue without MCP tools"),
        },
      ]);
      expect(factory).toHaveBeenCalledTimes(creations);
      for (const runtime of sources.keys()) {
        expect(runtime.callTool).not.toHaveBeenCalled();
      }
      await refused.dispose();
      // Another sender must never inherit Alice's embedded catalog.
      const bob = await materializeBundleMcpToolsForRun(
        await manager.acquire({ ...mixedParams, requesterSenderId: "bob" }),
      );
      expect(bob.tools.map((tool) => tool.name)).toEqual(["fixture__echo"]);
      await bob.dispose();
    });
  });

  it("bounds requester snapshots and keeps recent schemas reachable for retirement", async () => {
    await withRequester(async () => {
      const { manager } = setup();
      const input = (index: number) => ({
        ...mixedParams,
        sessionId: `scoped-${index}`,
        sessionKey: `agent:test:scoped-${index}`,
      });
      for (let index = 0; index < 512; index++) {
        const lease = (await manager.acquireRequesterScoped(input(index)))!;
        const catalog = await lease.runtime.getCatalog();
        manager.rememberAdvertisedScopedCatalog(lease, catalog);
        lease.releaseLease();
      }
      for (let index = 256; index < 512; index++) {
        held.push((await manager.acquireRequesterScoped(input(index)))!);
      }
      const continuing = (await manager.acquireRequesterScoped(input(0)))!;
      await continuing.runtime.getCatalog();
      continuing.releaseLease();
      held.shift()!.releaseLease();
      const next = (await manager.acquireRequesterScoped(input(512)))!;
      manager.rememberAdvertisedScopedCatalog(next, await next.runtime.getCatalog());
      held.push(next);
      expect(manager.getAdvertisedScopedCatalog("scoped-1")).toBeNull();
      expect(manager.resolveSessionId(input(1).sessionKey)).toBeUndefined();
      expect(manager.getAdvertisedScopedCatalog("scoped-0")?.tools).toHaveLength(1);
      expect(manager.listSessionIdsForAgent("test")).toHaveLength(512);
      const retirement = manager.captureSessionRetirement({ sessionKey: input(0).sessionKey });
      expect(retirement).toBeDefined();
      await retirement!.retire(() => {});
      expect(manager.getAdvertisedScopedCatalog("scoped-0")).toBeNull();
      expect(manager.resolveSessionId(input(0).sessionKey)).toBeUndefined();
    });
  });

  it("bounds evicted requester partitions within a session with live owners", async () => {
    await withRequester(async () => {
      const { manager, factory } = setup();
      const input = (index: number) => ({ ...mixedParams, requesterSenderId: `sender-${index}` });
      for (let index = 0; index < 513; index++) {
        const lease = (await manager.acquireRequesterScoped(input(index)))!;
        manager.rememberAdvertisedScopedCatalog(lease, await lease.runtime.getCatalog());
        lease.releaseLease();
      }
      for (let index = 257; index < 513; index++) {
        held.push((await manager.acquireRequesterScoped(input(index)))!);
      }
      const aged = (await manager.acquireRequesterScoped(input(0)))!;
      expect((await aged.runtime.getCatalog()).tools).toEqual([]);
      aged.releaseLease();
      const recent = (await manager.acquireRequesterScoped(input(1)))!;
      expect((await recent.runtime.getCatalog()).tools.map((tool) => tool.toolName)).toEqual([
        "echo",
      ]);
      recent.releaseLease();
      expect(manager.getAdvertisedScopedCatalog(params.sessionId)?.tools).toHaveLength(1);
      expect(factory).toHaveBeenCalledTimes(513);
    });
  });

  it("rejects the old publication handle when a live runtime changes agent binding", async () => {
    await withRequester(async () => {
      const { manager } = setup();
      const first = (await manager.acquireRequesterScoped(mixedParams))!;
      const catalog = await first.runtime.getCatalog();
      const rebound = (await manager.acquireRequesterScoped({ ...mixedParams, agentId: "other" }))!;
      expect(rebound.runtime).toBe(first.runtime);
      manager.rememberAdvertisedScopedCatalog(first, catalog);
      expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
      manager.rememberAdvertisedScopedCatalog(rebound, await rebound.runtime.getCatalog());
      expect(manager.getAdvertisedScopedCatalog(params.sessionId)?.tools).toHaveLength(1);
      first.releaseLease();
      rebound.releaseLease();
    });
  });

  it("rejects a discovery result completed after its catalog was cleared by reload", async () => {
    await withRequester(async () => {
      const { manager, sources } = setup();
      const first = (await manager.acquireRequesterScoped(mixedParams))!;
      const source = sources.get(first.runtime)!;
      const pending = createDeferred<McpToolCatalog>();
      source.pending = pending.promise;
      const late = first.runtime.getCatalog();
      await manager.reloadConfig({
        cfg: mixedParams.cfg,
        manifestRegistry: params.manifestRegistry,
      });
      const current = (await manager.acquireRequesterScoped(mixedParams))!;
      pending.resolve(source.catalog);
      manager.rememberAdvertisedScopedCatalog(first, await late);
      expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
      manager.rememberAdvertisedScopedCatalog(current, await current.runtime.getCatalog());
      expect(manager.getAdvertisedScopedCatalog(params.sessionId)?.tools).toHaveLength(1);
      first.releaseLease();
      current.releaseLease();
    });
  });

  it.each(["session", "deferred", "captured", "agent", "reload"])(
    "retires evicted requester catalogs through %s cleanup",
    async (retirement) => {
      await withRequester(async () => {
        const { manager, fill } = setup();
        const lease = (await manager.acquireRequesterScoped(mixedParams))!;
        manager.rememberAdvertisedScopedCatalog(lease, await lease.runtime.getCatalog());
        lease.releaseLease();
        await fill();
        expect(manager.resolveSessionId(params.sessionKey)).toBe(params.sessionId);
        expect(manager.listSessionIdsForAgent("test")).toContain(params.sessionId);
        if (retirement === "session") {
          await manager.disposeSession(params.sessionId);
        } else if (retirement === "deferred") {
          expect(manager.deferRetirement(params.sessionId)).toBe(true);
          expect(await manager.completeDeferredRetirement(params.sessionId)).toBe(true);
        } else if (retirement === "captured") {
          const captured = manager.captureSessionRetirement({ sessionKey: params.sessionKey });
          expect(captured).toBeDefined();
          await captured!.retire(() => {});
        } else if (retirement === "agent") {
          await manager.retireSessionForAgentDeletion(params.sessionId, "other", () => {});
          expect(manager.getAdvertisedScopedCatalog(params.sessionId)).not.toBeNull();
          await manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {});
        } else {
          await manager.reloadConfig({
            cfg: mixedParams.cfg,
            manifestRegistry: params.manifestRegistry,
          });
        }
        expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
        const refused = (await manager.acquireRequesterScoped(mixedParams))!;
        expect((await refused.runtime.getCatalog()).tools).toEqual([]);
        refused.releaseLease();
      });
    },
  );

  it.each([
    { workspaceDir: "/other-workspace" },
    { agentDir: "/agents/other" },
    { agentId: "other" },
    { sessionKey: "agent:test:other" },
    {
      cfg: {
        mcp: {
          servers: {
            scoped: { transport: "streamable-http" as const, headers: { variant: "changed" } },
          },
        },
      },
    },
  ])(
    "invalidates requester snapshots and advertised schemas on binding change: %j",
    async (change) => {
      await withRequester(async () => {
        const { manager, fill } = setup();
        const first = (await manager.acquireRequesterScoped(mixedParams))!;
        manager.rememberAdvertisedScopedCatalog(first, await first.runtime.getCatalog());
        first.releaseLease();
        await fill();
        const refused = (await manager.acquireRequesterScoped({ ...mixedParams, ...change }))!;
        expect((await refused.runtime.getCatalog()).tools).toEqual([]);
        expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
        refused.releaseLease();
      });
    },
  );

  it("preserves acquired static tools when requester admission is refused", async () => {
    await withRequester(async () => {
      const { manager, fill } = setup();
      await fill(255);
      const acquired = await manager.acquire(mixedParams);
      const tools = await materializeBundleMcpToolsForRun(acquired);
      expect(tools.tools.map((tool) => tool.name)).toEqual(["fixture__echo"]);
      expect((await tools.tools[0]!.execute("static-call", {})).content).toEqual([
        { type: "text", text: "live echo" },
      ]);
      expect(manager.peekSession({ sessionId: params.sessionId })!.activeLeases).toBe(1);
      expect(tools.diagnostics?.[0]?.message).toContain(
        "This turn will continue without MCP tools",
      );
      await tools.dispose();
      expect(manager.peekSession({ sessionId: params.sessionId })!.activeLeases).toBe(0);
    });
  });

  it("preserves a reusable requester partition when static admission is refused", async () => {
    await withRequester(async () => {
      const { manager, fill } = setup();
      const requester = await manager.acquireRequesterScoped(mixedParams);
      held.push(requester!);
      manager.rememberAdvertisedScopedCatalog(requester!, await requester!.runtime.getCatalog());
      const preflight = await materializeBundleMcpToolsForRun(
        await manager.acquire({ ...params, requesterSenderId: "alice" }),
      );
      await preflight.dispose();
      expect(
        manager.getAdvertisedScopedCatalog(params.sessionId)?.tools.map((tool) => tool.toolName),
      ).toEqual(["echo"]);
      await fill(255);
      const tools = await materializeBundleMcpToolsForRun(await manager.acquire(mixedParams));
      expect(tools.tools.map((tool) => tool.name)).toEqual(["scoped__echo"]);
      expect((await tools.tools[0]!.execute("requester-call", {})).content).toEqual([
        { type: "text", text: "live echo" },
      ]);
      await tools.dispose();
    });
  });

  it.each([
    { sessionId: "other-session", sessionKey: "agent:test:other-session" },
    { workspaceDir: "/other-workspace" },
    { agentDir: "/agents/other" },
    { agentId: "other" },
    { cfg: { mcp: { servers: { fixture: { command: "changed" } } } } },
  ])("invalidates a static snapshot when its binding changes: %j", async (change) => {
    const { manager, fill } = setup();
    const first = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    await first.dispose();
    await fill();
    const refused = await materializeBundleMcpToolsForRun(
      await manager.acquire({ ...params, ...change }),
    );
    expect(refused.tools).toEqual([]);
    await refused.dispose();
  });

  it.each(["reload", "replacement"])(
    "does not republish an old catalog after %s while discovery is pending",
    async (invalidation) => {
      const { manager, sources, fill } = setup();
      const acquired = await manager.acquire(params);
      const source = sources.get(acquired.runtime)!;
      const pending = createDeferred<McpToolCatalog>();
      source.pending = pending.promise;
      const late = acquired.runtime.getCatalog();
      const nextParams =
        invalidation === "replacement"
          ? { ...params, cfg: { mcp: { servers: { fixture: { command: "replacement" } } } } }
          : params;
      if (invalidation === "reload") {
        await manager.reloadConfig({ cfg: params.cfg, manifestRegistry: params.manifestRegistry });
      } else {
        const replacement = await manager.acquire(nextParams);
        replacement.releaseLease();
      }
      pending.resolve(source.catalog);
      await late;
      acquired.releaseLease();
      await fill();
      const refused = await materializeBundleMcpToolsForRun(await manager.acquire(nextParams));
      expect(refused.tools).toEqual([]);
      await refused.dispose();
    },
  );

  it("keeps snapshot-only sessions reachable for agent cleanup and captured retirement", async () => {
    const { manager, fill } = setup();
    const first = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    await first.dispose();
    await fill();
    expect(manager.listSessionIdsForAgent("test")).toContain(params.sessionId);
    expect(manager.resolveSessionId(params.sessionKey)).toBe(params.sessionId);
    const retirement = manager.captureSessionRetirement({ sessionKey: params.sessionKey });
    expect(retirement).toBeDefined();
    await retirement!.retire(() => {});
    const refused = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect(refused.tools).toEqual([]);
    await refused.dispose();
  });

  it("bounds evicted static catalogs and retains the most recently used session", async () => {
    const { manager } = setup();
    const input = (index: number) => ({
      ...params,
      sessionId: `one-off-${index}`,
      sessionKey: `agent:test:one-off-${index}`,
    });
    for (let index = 0; index < 512; index++) {
      const lease = await manager.acquire(input(index));
      await lease.runtime.getCatalog();
      lease.releaseLease();
    }
    expect(manager.listSessionIdsForAgent("test")).toHaveLength(512);
    // Refused reuse still refreshes retention recency, without creating a runtime.
    for (let index = 256; index < 512; index++) {
      held.push(await manager.acquire(input(index)));
    }
    const continuing = await manager.acquire(input(0));
    expect((await continuing.runtime.getCatalog()).tools).toHaveLength(1);
    continuing.releaseLease();
    held.shift()!.releaseLease();
    const next = await manager.acquire(input(512));
    await next.runtime.getCatalog();
    held.push(next);
    expect(manager.listSessionIdsForAgent("test")).toHaveLength(512);
    expect(manager.resolveSessionId(input(1).sessionKey)).toBeUndefined();
    expect(manager.resolveSessionId(input(0).sessionKey)).toBe("one-off-0");
    const retained = await manager.acquire(input(0));
    expect((await retained.runtime.getCatalog()).tools).toHaveLength(1);
    retained.releaseLease();
    await manager.disposeSession("one-off-0");
    expect(manager.resolveSessionId(input(0).sessionKey)).toBeUndefined();
  });

  it.each([false, true])(
    "retires an evicted static catalog through deferred retirement (retainAcrossReuse=%s)",
    async (retainAcrossReuse) => {
      const { manager, fill } = setup();
      const first = await materializeBundleMcpToolsForRun(await manager.acquire(params));
      await first.dispose();
      await fill();
      expect(manager.deferRetirement(params.sessionId, { retainAcrossReuse })).toBe(true);
      expect(await manager.completeDeferredRetirement(params.sessionId)).toBe(true);
      expect(manager.resolveSessionId(params.sessionKey)).toBeUndefined();
      const retired = await materializeBundleMcpToolsForRun(await manager.acquire(params));
      expect(retired.tools).toEqual([]);
      await retired.dispose();
    },
  );

  it("allows only the owning agent to retire an evicted static catalog", async () => {
    const { manager, fill } = setup();
    const first = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    await first.dispose();
    await fill();
    await manager.retireSessionForAgentDeletion(params.sessionId, "other", () => {});
    const retained = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect(retained.tools.map((tool) => tool.name)).toEqual(["fixture__echo"]);
    await retained.dispose();
    await manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {});
    const retired = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect(retired.tools).toEqual([]);
    await retired.dispose();
  });

  it.each(["static", "requester"])(
    "refuses replacement after failed %s eviction cleanup without blocking another key",
    async (scope) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.setSystemTime(1_000);
      const { manager, factory } = setup();
      try {
        await withRequester(async () => {
          const acquire = async (sessionId: string, sender = "alice") => {
            const lease =
              scope === "static"
                ? await manager.acquire({ ...params, sessionId })
                : (await manager.acquireRequesterScoped({
                    ...mixedParams,
                    sessionId,
                    requesterSenderId: sender,
                  }))!;
            held.push(lease);
            return lease;
          };
          const original = await acquire("uncertain");
          original.runtime.joinCleanup = async () => {
            throw new Error("child cleanup uncertain");
          };
          original.releaseLease();
          const healthy = await acquire("healthy");
          healthy.releaseLease();
          for (let index = 0; index < 254; index++) {
            await acquire(`busy-${index}`);
          }
          const admitted = await acquire("admitted");
          admitted.releaseLease();
          expect(original.runtime.dispose).toHaveBeenCalledOnce();
          expect(factory).toHaveBeenCalledTimes(257);
          expect(manager.listSessionIdsForAgent("test")).toContain("uncertain");

          const refused = await acquire("uncertain");
          expect(factory).toHaveBeenCalledTimes(257);
          expect((await refused.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
            "previous runtime has not confirmed shutdown",
          );
          expect(admitted.runtime.dispose).not.toHaveBeenCalled();

          // A failed requester partition does not poison another sender in the session.
          const unrelated = await acquire(scope === "requester" ? "uncertain" : "unrelated", "bob");
          expect(factory).toHaveBeenCalledTimes(258);
          expect((await unrelated.runtime.getCatalog()).diagnostics).toBeUndefined();
          await expect(
            manager.retireSessionForAgentDeletion("uncertain", "test", () => {}),
          ).rejects.toThrow("child cleanup uncertain");
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
