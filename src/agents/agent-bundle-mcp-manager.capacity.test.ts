import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { retireSessionMcpRuntimeForSessionKey } from "./agent-bundle-mcp-manager-api.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import type { SessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import {
  SESSION_MCP_RUNTIME_MANAGER_KEY,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";

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
  const manager = createSessionMcpRuntimeManager({ createRuntime });
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

function withRequesterResolver(run: () => Promise<void>) {
  const resolverRegistry = createMcpProofPluginRegistry();
  return withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
    resolverRegistry.apiFor("test-plugin").registerMcpServerConnectionResolver({
      serverName: "scoped",
      resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
    });
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

describe("MCP runtime capacity ownership", () => {
  it("evicts the oldest idle runtime at capacity while preserving leased runtimes", async () => {
    const manager = createManager(createRuntimeFixture);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const leases = [];
    for (let index = 0; index < 256; index += 1) {
      leases.push(await manager.acquire({ ...params, sessionId: `capacity-${index}`, cfg }));
    }
    const idle = expectDefined(leases[0], "oldest runtime lease");
    const newer = expectDefined(leases[1], "newer idle runtime");
    Object.defineProperty(idle.runtime, "lastUsedAt", { get: () => 1 });
    Object.defineProperty(newer.runtime, "lastUsedAt", { get: () => 2 });
    idle.releaseLease();
    newer.releaseLease();
    const next = await manager.acquire({ ...params, sessionId: "capacity-next", cfg });
    expect(idle.runtime.dispose).toHaveBeenCalledOnce();
    expect(newer.runtime.dispose).not.toHaveBeenCalled();
    expect(manager.listRuntimeKeys()).toHaveLength(256);
    expect(manager.peekSession({ sessionId: "capacity-1" })).toBe(
      expectDefined(leases[1], "busy runtime lease").runtime,
    );
    next.releaseLease();
    leases.forEach((lease) => lease.releaseLease());
  });

  it("returns an explicit unavailable runtime when every capacity slot is leased", async () => {
    const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createManager(factory);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const leases = [];
    for (let index = 0; index < 256; index += 1) {
      leases.push(await manager.acquire({ ...params, sessionId: "busy-" + index, cfg }));
    }
    const refused = await manager.acquire({ ...params, sessionId: "busy-next", cfg });
    expect((await refused.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
      "temporarily unavailable",
    );
    expect(await refused.runtime.callTool("fixture", "read", {})).toMatchObject({ isError: true });
    expect(factory).toHaveBeenCalledTimes(256);
    refused.releaseLease();
    leases.forEach((lease) => lease.releaseLease());
  });

  it("evicts an idle requester sibling but preserves its live canonical runtime", async () => {
    const manager = createManager(createRuntimeFixture);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    await withRequesterResolver(async () => {
      const canonical = await manager.getOrCreate({ ...params, cfg });
      const claim = claimAgentRunContext(
        "capacity-live",
        { sessionId: params.sessionId, sessionKey: params.sessionKey },
        { trackOwner: true },
      );
      try {
        const sibling = expectDefined(
          await manager.getOrCreateRequesterScoped(requesterParams("idle-sender")),
          "requester sibling",
        );
        const leases = [];
        for (let index = 0; index < 254; index += 1) {
          leases.push(await manager.acquire({ ...params, sessionId: "protected-" + index, cfg }));
        }
        const next = await manager.acquire({ ...params, sessionId: "sibling-next", cfg });
        expect(sibling.runtime.dispose).toHaveBeenCalledOnce();
        expect(canonical.dispose).not.toHaveBeenCalled();
        expect(manager.peekSession({ sessionId: params.sessionId })).toBe(canonical);
        next.releaseLease();
        leases.forEach((lease) => lease.releaseLease());
      } finally {
        releaseAgentRunContext("capacity-live", claim);
      }
    });
  });

  it("keeps serverless sessions available beyond the MCP limit and while it is full", async () => {
    const manager = createManager(createRuntimeFixture);
    for (let index = 0; index < 300; index += 1) {
      await manager.getOrCreate({ ...params, sessionId: `serverless-${index}` });
    }
    const configured = { mcp: { servers: { fixture: { command: "true" } } } };
    const leases = [];
    for (let index = 0; index < 256; index += 1) {
      leases.push(
        await manager.acquire({ ...params, sessionId: `connected-${index}`, cfg: configured }),
      );
    }
    await manager.getOrCreate({ ...params, sessionId: "serverless-at-capacity" });
    const unavailable = await manager.getOrCreate({
      ...params,
      sessionId: "connected-overflow",
      cfg: configured,
    });
    expect((await unavailable.getCatalog()).diagnostics?.[0]?.message).toContain(
      "temporarily unavailable",
    );
    const upgrading = await manager.getOrCreate({
      ...params,
      sessionId: "serverless-0",
      cfg: configured,
    });
    expect((await upgrading.getCatalog()).diagnostics?.[0]?.message).toContain(
      "temporarily unavailable",
    );
    expectDefined(leases[0], "first connected lease").releaseLease();
    await manager.getOrCreate({ ...params, sessionId: "connected-0" });
    await manager.getOrCreate({ ...params, sessionId: "serverless-0", cfg: configured });
    leases.forEach((lease) => lease.releaseLease());
  });

  it("bounds requester runtimes across sessions, creation, and cleanup", async () => {
    const held = holdFactory();
    const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createManager(factory);
    const acquire = (sessionId: string) =>
      manager.acquireRequesterScoped({ ...requesterParams("sender"), sessionId });
    await withRequesterResolver(async () => {
      const leases = [];
      for (let index = 0; index < 255; index += 1) {
        leases.push(expectDefined(await acquire(`bounded-${index}`), "requester lease"));
      }
      factory.mockImplementationOnce(held.createRuntime);
      const last = acquire("last-slot");
      await held.started;
      const unavailable = expectDefined(await acquire("overflow"), "unavailable requester lease");
      expect((await unavailable.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
        "temporarily unavailable",
      );
      unavailable.releaseLease();
      held.release();
      leases.push(expectDefined(await last, "last requester lease"));
      const firstKey = expectDefined(
        manager
          .listRuntimeKeys()
          .find((key) => key === "bounded-0" || key.includes('"sessionId":"bounded-0"')),
        "first runtime key",
      );
      const first = expectDefined(manager.peekSession({ sessionId: firstKey }), "first runtime");
      const reused = expectDefined(await acquire("bounded-0"), "reused lease");
      reused.releaseLease();
      expect(first.dispose).not.toHaveBeenCalled();
      const closing = holdDisposal(first);
      expectDefined(leases[0], "first requester lease").releaseLease();
      const disposal = manager.disposeSession("bounded-0");
      await closing.started;
      const duringClose = expectDefined(await acquire("overflow"), "unavailable during close");
      expect((await duringClose.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
        "temporarily unavailable",
      );
      duringClose.releaseLease();
      closing.release();
      await disposal;
      expectDefined(await acquire("overflow"), "recovered lease").releaseLease();
      leases.forEach((lease) => lease.releaseLease());
      expect(manager.listRuntimeKeys()).toHaveLength(256);
      await manager.disposeAll();
      expectDefined(await acquire("after-shutdown"), "after shutdown lease").releaseLease();
      expect(manager.listSessionIds()).toEqual(["after-shutdown"]);
    });
  });

  it("keeps replacement capacity reserved when an old child's cleanup is uncertain", async () => {
    // The real factory registers the replacement owner; the generic fixture cannot exercise
    // creation of the successor facade before the previous runtime confirms cleanup.
    const createRuntime = vi.fn<CreateSessionMcpRuntime>(createSessionMcpRuntime);
    const manager = createManager(createRuntime);
    const releaseLeases: Array<() => void> = [];
    const input = {
      sessionId: "uncertain-child",
      workspaceDir: "/workspace",
      manifestRegistry: { plugins: [] },
      cfg: { plugins: { enabled: false }, mcp: { servers: { child: { command: "true" } } } },
    };
    try {
      const previous = await manager.getOrCreate(input);
      previous.joinCleanup = async () => {
        throw new Error("child cleanup uncertain");
      };
      await expect(manager.getOrCreate({ ...input, workspaceDir: "/replacement" })).rejects.toThrow(
        "child cleanup uncertain",
      );
      for (let index = 0; index < 255; index += 1) {
        const lease = await manager.acquire({ ...input, sessionId: `other-${index}` });
        releaseLeases.push(lease.releaseLease);
      }
      const overflow = await manager.acquire({ ...input, sessionId: "overflow" });
      releaseLeases.push(overflow.releaseLease);
      expect((await overflow.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
        "temporarily unavailable",
      );
      expect(createRuntime).toHaveBeenCalledTimes(256);
    } finally {
      releaseLeases.forEach((release) => release());
    }
  });

  it("keeps failed cleanup capacity reserved and refuses replacement of its exact key", async () => {
    const factory = vi.fn<CreateSessionMcpRuntime>(createRuntimeFixture);
    const manager = createManager(factory);
    const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
    const leases = [];
    for (let index = 0; index < 256; index += 1) {
      leases.push(await manager.acquire({ ...params, sessionId: "failed-" + index, cfg }));
    }
    const failed = expectDefined(leases[0], "failed runtime lease");
    failed.runtime.joinCleanup = async () => {
      throw new Error("closure unconfirmed");
    };
    failed.releaseLease();
    const refused = await manager.acquire({ ...params, sessionId: "failed-overflow", cfg });
    expect((await refused.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
      "temporarily unavailable",
    );
    const replacement = await manager.acquire({ ...params, sessionId: "failed-0", cfg });
    expect((await replacement.runtime.getCatalog()).diagnostics?.[0]?.message).toContain(
      "not confirmed shutdown",
    );
    expect(factory).toHaveBeenCalledTimes(256);
    refused.releaseLease();
    replacement.releaseLease();
    leases.forEach((lease) => lease.releaseLease());
  });

  it("preserves advertised requester schemas at refusal and retires snapshot-only sessions by key", async () => {
    const manager = createManager(createRuntimeFixture);
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const previous = globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
    globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = manager;
    try {
      await withRequesterResolver(async () => {
        const input = requesterParams("snapshot-sender");
        const handle = expectDefined(
          await manager.acquireRequesterScoped(input),
          "requester handle",
        );
        const catalog: McpToolCatalog = {
          version: 1,
          generatedAt: 0,
          servers: { scoped: { serverName: "scoped", launchSummary: "test", toolCount: 1 } },
          tools: [
            {
              serverName: "scoped",
              safeServerName: "scoped",
              toolName: "read",
              inputSchema: Type.Object({}),
              fallbackDescription: "Read test data",
            },
          ],
        };
        manager.rememberAdvertisedScopedCatalog(handle, catalog);
        handle.releaseLease();
        const leases = [];
        const cfg = { mcp: { servers: { fixture: { command: "true" } } } };
        for (let index = 0; index < 256; index += 1) {
          leases.push(
            await manager.acquire({
              ...params,
              sessionId: "snapshot-busy-" + index,
              sessionKey: undefined,
              cfg,
            }),
          );
        }
        expect(handle.runtime.dispose).toHaveBeenCalledOnce();
        const refused = expectDefined(
          await manager.acquireRequesterScoped(input),
          "refused requester",
        );
        expect((await refused.runtime.getCatalog()).tools).toEqual(catalog.tools);
        expect(await refused.runtime.callTool("scoped", "read", {})).toMatchObject({
          isError: true,
        });
        expect(refused.runtime.requesterScope?.requesterSenderId).toBe("snapshot-sender");
        expect(refused.runtime.requesterConnect).toBeUndefined();
        refused.releaseLease();
        expect(manager.resolveSessionId(params.sessionKey)).toBe(params.sessionId);
        await expect(
          retireSessionMcpRuntimeForSessionKey({
            sessionKey: params.sessionKey,
            reason: "test",
            preserveActiveLeases: true,
          }),
        ).resolves.toBe(true);
        expect(manager.getAdvertisedScopedCatalog(params.sessionId)).toBeNull();
        expect(manager.resolveSessionId(params.sessionKey)).toBeUndefined();
        leases.forEach((lease) => lease.releaseLease());
      });
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalStore, SESSION_MCP_RUNTIME_MANAGER_KEY);
      } else {
        globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = previous;
      }
    }
  });
});
