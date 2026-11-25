import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as logger from "../logger.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { startMcpLifecycleServer } from "./agent-bundle-mcp-lifecycle.test-support.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reacquires MCP tools after a failed server's DELETE times out beside a healthy server", async () => {
  const deleteStarted = createDeferred();
  const finishDelete = createDeferred();
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => (ms === 5_000 ? deadline.signal : originalTimeout(ms)));
  const warn = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
  let failDiscovery = true;
  const server = await startMcpLifecycleServer({
    toolName: "probe",
    onList: async (endpoint) => {
      if (endpoint === "/failed" && failDiscovery) {
        throw new Error("fixture discovery failure");
      }
    },
    onDelete: async (endpoint) => {
      if (endpoint === "/failed" && failDiscovery) {
        deleteStarted.resolve();
        await finishDelete.promise;
      }
    },
    text: (endpoint) => endpoint,
  });
  const scheduler = createTestGatewayScheduler();
  const manager = createSessionMcpRuntimeManager({ scheduler });
  const params = {
    sessionId: "http-cleanup-replacement",
    workspaceDir: tempDirs.make("openclaw-mcp-delete-"),
    manifestRegistry: { plugins: [] },
    cfg: {
      plugins: { enabled: false },
      mcp: {
        servers: {
          healthy: { transport: "streamable-http" as const, url: `${server.url}/healthy` },
          failed: { transport: "streamable-http" as const, url: `${server.url}/failed` },
        },
      },
    },
  };
  try {
    const first = await manager.acquire(params);
    try {
      const catalog = first.runtime.getCatalog();
      await deleteStarted.promise;
      // Inject the HTTP deadline after the server receives DELETE, without a wall-clock wait.
      deadline.abort(new DOMException("fixture DELETE timeout", "TimeoutError"));
      expect((await catalog).tools.map((tool) => tool.serverName)).toEqual(["healthy"]);
    } finally {
      first.releaseLease();
    }
    await first.retireUnusedServers?.(new Set(["healthy"]));
    failDiscovery = false;
    finishDelete.resolve();
    timeout.mockRestore();

    const next = await manager.acquire(params);
    try {
      expect(
        (await next.runtime.getCatalog()).tools.map((tool) => tool.serverName).toSorted(),
      ).toEqual(["failed", "healthy"]);
      await expect(next.runtime.callTool("healthy", "probe", {})).resolves.toMatchObject({
        content: [{ type: "text", text: "/healthy" }],
      });
      expect(warn).toHaveBeenCalledWith(
        "bundle-mcp: remote session termination was not confirmed; continuing local cleanup",
      );
    } finally {
      next.releaseLease();
    }
  } finally {
    finishDelete.resolve();
    timeout.mockRestore();
    await manager.disposeAll();
    await scheduler.stop();
    await server.close();
    warn.mockRestore();
  }
});
