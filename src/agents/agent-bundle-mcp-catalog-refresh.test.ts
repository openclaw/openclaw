import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startMcpLifecycleServer } from "./agent-bundle-mcp-lifecycle.test-support.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { refreshMcpCatalog, snapshotMcpTools } from "./agent-bundle-mcp-recovery.test-support.js";
import type { BundleMcpToolRuntime } from "./agent-bundle-mcp-types.js";

it.for([false, true])(
  "keeps a subagent's first-send snapshot while refresh is held (changed=%s)",
  async (changed, { signal }) => {
    const scheduler = createTestGatewayScheduler();
    const manager = createSessionMcpRuntimeManager({ scheduler });
    const refreshing = createDeferred();
    const release = createDeferred();
    let lists = 0;
    const serverOptions = {
      toolName: "probe",
      text: () => "called",
      async onList() {
        if (++lists > 1) {
          refreshing.resolve();
          await release.promise;
        }
      },
    };
    const server = await startMcpLifecycleServer(serverOptions);
    const config = {
      workspaceDir: "/synthetic/mcp-refresh",
      manifestRegistry: { plugins: [] },
      cfg: {
        plugins: { enabled: false },
        mcp: { servers: { fixture: { url: server.url, transport: "streamable-http" as const } } },
      },
    };
    let preparing: Promise<BundleMcpToolRuntime> | undefined;
    try {
      const initial = await snapshotMcpTools(
        await manager.acquire({ ...config, sessionId: "parent" }),
      );
      expect(initial.bytes).toContain("fixture__probe");
      if (changed) {
        await manager.reloadConfig({ cfg: config.cfg });
      }
      const acquired = await manager.acquire({
        ...config,
        sessionId: "child",
        sessionKey: "agent:main:subagent:child",
        workspaceDir: "/synthetic/child-worktree",
      });
      let prepared: BundleMcpToolRuntime | undefined;
      preparing = materializeBundleMcpToolsForRun(acquired).then((result) => (prepared = result));
      await refreshing.promise;
      expect(prepared?.tools.map((tool) => tool.name)).toEqual(["fixture__probe"]);
      expect(prepared?.diagnostics).toBeUndefined();
      const refreshed = refreshMcpCatalog(acquired.runtime, signal);
      serverOptions.toolName = changed ? "updated_probe" : "probe";
      release.resolve();
      await refreshed;
      expect(lists).toBe(2);
      const next = await snapshotMcpTools({ runtime: acquired.runtime });
      if (changed) {
        expect(next.bytes).toContain("fixture__updated_probe");
        expect(prepared?.tools.map((tool) => tool.name)).toEqual(["fixture__probe"]);
      } else {
        expect(next.bytes).toBe(initial.bytes);
      }
      await expect(
        acquired.runtime.callTool("fixture", serverOptions.toolName, {}),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "called" }],
      });
    } finally {
      release.resolve();
      await (await preparing)?.dispose();
      await manager.disposeAll();
      await scheduler.stop();
      await server.close();
    }
  },
);

it.for(["endpoint", "headers", "agentDir"] as const)(
  "does not reuse a catalog across a changed %s",
  async (change) => {
    const scheduler = createTestGatewayScheduler();
    const manager = createSessionMcpRuntimeManager({ scheduler });
    const listing = createDeferred();
    const release = createDeferred();
    let lists = 0;
    const server = await startMcpLifecycleServer({
      toolName: "probe",
      text: () => "called",
      async onList() {
        if (++lists > 1) {
          listing.resolve();
          await release.promise;
        }
      },
    });
    const config = {
      workspaceDir: "/synthetic/mcp-identity",
      agentDir: "/synthetic/principal-a",
      manifestRegistry: { plugins: [] },
      cfg: {
        plugins: { enabled: false },
        mcp: { servers: { fixture: { url: server.url, transport: "streamable-http" as const } } },
      },
    };
    let preparing: Promise<BundleMcpToolRuntime> | undefined;
    try {
      await snapshotMcpTools(await manager.acquire({ ...config, sessionId: "known" }));
      let prepared: BundleMcpToolRuntime | undefined;
      preparing = materializeBundleMcpToolsForRun(
        await manager.acquire({
          ...config,
          sessionId: "different",
          agentDir: change === "agentDir" ? "/synthetic/principal-b" : config.agentDir,
          cfg: {
            ...config.cfg,
            mcp: {
              servers: {
                fixture: {
                  ...config.cfg.mcp.servers.fixture,
                  ...(change === "endpoint" ? { url: `${server.url}/different` } : {}),
                  ...(change === "headers"
                    ? { headers: { "X-Synthetic-Principal": "different" } }
                    : {}),
                },
              },
            },
          },
        }),
      ).then((result) => (prepared = result));
      await listing.promise;
      expect(prepared).toBeUndefined();
      release.resolve();
      expect((await preparing).tools.map((tool) => tool.name)).toEqual(["fixture__probe"]);
    } finally {
      release.resolve();
      await (await preparing)?.dispose();
      await manager.disposeAll();
      await scheduler.stop();
      await server.close();
    }
  },
);

it("bounds a first-ever hung listing and keeps its diagnostic alongside healthy tools", async () => {
  const scheduler = createTestGatewayScheduler();
  const manager = createSessionMcpRuntimeManager({ scheduler });
  const listed = createDeferred();
  const release = createDeferred();
  const server = await startMcpLifecycleServer({
    toolName: "probe",
    text: () => "called",
    async onList(endpoint) {
      if (endpoint === "/hung") {
        listed.resolve();
        await release.promise;
      }
    },
  });
  let preparing: Promise<BundleMcpToolRuntime> | undefined;
  try {
    const acquired = await manager.acquire({
      sessionId: "first-ever",
      workspaceDir: "/synthetic/first-ever",
      manifestRegistry: { plugins: [] },
      cfg: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            healthy: { url: `${server.url}/healthy`, transport: "streamable-http" },
            hung: { url: `${server.url}/hung`, transport: "streamable-http" },
          },
        },
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    preparing = materializeBundleMcpToolsForRun(acquired);
    await listed.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    const prepared = await preparing;
    expect(prepared.tools.map((tool) => tool.name)).toEqual(["healthy__probe"]);
    expect(prepared.diagnostics).toEqual([
      expect.objectContaining({
        serverName: "hung",
        message: "MCP tool listing timed out after 10000ms",
      }),
    ]);
  } finally {
    vi.useRealTimers();
    release.resolve();
    await (await preparing)?.dispose();
    await manager.disposeAll();
    await scheduler.stop();
    await server.close();
  }
});
