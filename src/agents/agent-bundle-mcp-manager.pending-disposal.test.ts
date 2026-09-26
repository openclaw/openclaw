// Disposal settlement owns the last cleanup of bindings left by empty successors.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { startCatalogRecoveryMcpServer } from "./agent-bundle-mcp-catalog-recovery.test-support.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";

const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);
type RuntimeParams = Parameters<ReturnType<typeof createSessionMcpRuntimeManager>["acquire"]>[0];

it("forgets an empty successor binding after the original idle disposal settles", async () => {
  const terminate = createDeferred();
  const server = await startCatalogRecoveryMcpServer("idle-empty-successor", {
    holdTermination: terminate.promise,
  });
  let nowMs = Date.now();
  const manager = createSessionMcpRuntimeManager({
    enableIdleSweepTimer: false,
    now: () => nowMs,
  });
  const params: RuntimeParams = {
    sessionId: "idle-empty-successor",
    sessionKey: "agent:test:idle-empty-successor",
    workspaceDir: tempDirTracker.make("mcp-idle-empty-successor-"),
    manifestRegistry: { plugins: [] },
    cfg: {
      plugins: { enabled: false },
      mcp: {
        sessionIdleTtlMs: 100,
        servers: { fixture: { url: server.url, transport: "streamable-http" } },
      },
    },
  };
  const sessionKey = expectDefined(params.sessionKey, "MCP session key");
  let sweep: Promise<number> | undefined;
  try {
    const original = await manager.acquire(params);
    try {
      expect((await original.runtime.getCatalog()).tools).toHaveLength(1);
      nowMs = original.runtime.lastUsedAt + 100;
    } finally {
      original.releaseLease();
    }
    sweep = manager.sweepIdleRuntimes();
    await withTestTimeout(server.terminationStarted, 2_000, "MCP idle disposal did not start");

    const cfg = { plugins: { enabled: false }, mcp: { servers: {} } };
    await manager.reloadConfig({ cfg });
    const successor = await manager.acquire({ ...params, cfg });
    try {
      expect((await successor.runtime.getCatalog()).tools).toEqual([]);
    } finally {
      successor.releaseLease();
    }
    expect(manager.listRuntimeKeys()).toEqual([]);
    expect(manager.resolveSessionId(sessionKey)).toBe(params.sessionId);

    terminate.resolve();
    await expect(sweep).resolves.toBe(1);
    expect(manager.resolveSessionId(sessionKey)).toBeUndefined();
    expect(server.terminationCount()).toBe(1);
  } finally {
    terminate.resolve();
    await Promise.allSettled([sweep]);
    try {
      await manager.disposeAll();
    } finally {
      await server.close();
    }
  }
});
