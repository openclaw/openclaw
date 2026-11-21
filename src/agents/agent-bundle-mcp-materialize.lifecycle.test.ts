import { expect, it, vi } from "vitest";
import type { McpToolCatalog } from "./agent-bundle-mcp-catalog.types.js";
import {
  fixtureCatalog,
  fixtureRuntime,
  staticRuntime,
} from "./agent-bundle-mcp-fixture.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { guardWebchatMcpTools } from "./agent-bundle-mcp-webchat-requester.js";

// The manager may be loaded by acquisition, but a new importer still needs its file.
vi.mock("./agent-bundle-mcp-manager-api.js", () => {
  throw new Error("ERR_MODULE_NOT_FOUND: replaced MCP manager chunk");
});

it("releases a materialized view without loading the manager during shutdown", async () => {
  const catalog: McpToolCatalog = { version: 1, generatedAt: 0, servers: {}, tools: [] };
  const releaseLease = vi.fn();
  const disposeRuntime = vi.fn(async () => {});
  const joinCleanup = vi.fn(async () => {});
  const runtime: SessionMcpRuntime = staticRuntime({
    sessionId: "shutdown-fixture",
    workspaceDir: "/synthetic",
    configFingerprint: "fixture",
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    callTool: async () => ({ content: [] }),
    dispose: disposeRuntime,
    joinCleanup,
  });
  const view = await materializeBundleMcpToolsForRun({ runtime, releaseLease, disposeRuntime });

  await view.dispose();
  await view.dispose();

  expect(releaseLease).toHaveBeenCalledOnce();
  expect(disposeRuntime).toHaveBeenCalledOnce();
  expect(joinCleanup).toHaveBeenCalledTimes(2);
});

it.each(["shared", "personal", "connect"] as const)(
  "checks browser authority only for personal tools (%s)",
  async (kind) => {
    const catalog = fixtureCatalog("calendar", [{ toolName: "events" }]);
    const callTool = vi.fn(async () => ({ content: [] }));
    const assertRequesterCurrent = vi.fn(() => {
      throw new Error("requester is ambiguous");
    });
    const runtime = fixtureRuntime(() => catalog, {
      isRequesterScopedServer: () => kind === "personal",
      ...(kind === "connect"
        ? {
            requesterConnect: {
              catalog,
              authorizedServerNames: [],
              configFingerprint: "connect-only",
              createExecute: () => undefined,
            },
          }
        : {}),
      callTool,
      joinCleanup: async () => {},
    });
    const view = await materializeBundleMcpToolsForRun({
      runtime,
      releaseLease: () => {},
    });
    guardWebchatMcpTools(view, runtime, assertRequesterCurrent);
    try {
      const tool = view.tools.find((candidate) => candidate.name === "calendar__events")!;
      if (kind !== "shared") {
        await expect(tool.execute("call", {})).rejects.toThrow("requester is ambiguous");
        expect(callTool).not.toHaveBeenCalled();
      } else {
        await tool.execute("call", {});
        expect(callTool).toHaveBeenCalledOnce();
        expect(assertRequesterCurrent).not.toHaveBeenCalled();
      }
    } finally {
      await view.dispose();
    }
  },
);
