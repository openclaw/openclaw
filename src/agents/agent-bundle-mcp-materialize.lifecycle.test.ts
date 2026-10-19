import { expect, it, vi } from "vitest";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

// The manager may be loaded by acquisition, but a new importer still needs its file.
vi.mock("./agent-bundle-mcp-manager-api.js", () => {
  throw new Error("ERR_MODULE_NOT_FOUND: replaced MCP manager chunk");
});

it("releases a materialized view without loading the manager during shutdown", async () => {
  const catalog: McpToolCatalog = { version: 1, generatedAt: 0, servers: {}, tools: [] };
  const releaseLease = vi.fn();
  const disposeRuntime = vi.fn(async () => {});
  const joinCleanup = vi.fn(async () => {});
  const runtime: SessionMcpRuntime = {
    sessionId: "shutdown-fixture",
    workspaceDir: "/synthetic",
    configFingerprint: "fixture",
    createdAt: 0,
    lastUsedAt: 0,
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    markUsed: () => {},
    callTool: async () => ({ content: [] }),
    dispose: disposeRuntime,
    joinCleanup,
  };
  const view = await materializeBundleMcpToolsForRun({ runtime, releaseLease, disposeRuntime });

  await view.dispose();
  await view.dispose();

  expect(releaseLease).toHaveBeenCalledOnce();
  expect(disposeRuntime).toHaveBeenCalledOnce();
  expect(joinCleanup).toHaveBeenCalledTimes(2);
});
