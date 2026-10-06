import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  bindSessionMcpRuntimeTestScheduler,
  getOrCreateSessionMcpRuntime,
} from "./agent-bundle-mcp-manager.test-support.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import { testing } from "./agent-bundle-mcp-runtime.js";
import {
  waitForRuntimeState,
  writeListToolsMcpServer,
} from "./agent-bundle-mcp-stdio.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-tools.js";

vi.mock("./embedded-agent-mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedded-agent-mcp.js")>();
  return {
    ...actual,
    loadEmbeddedAgentMcpConfig: (
      params: Parameters<typeof actual.loadEmbeddedAgentMcpConfig>[0],
    ) => ({
      diagnostics: [],
      prepareDataDirsByServer: {},
      mcpServers: params.cfg?.mcp?.servers ?? {},
    }),
  };
});

vi.mock("./mcp-auth-profile.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-auth-profile.js")>()),
  resolveMcpAuthProfileId: () => undefined,
  withMcpAuthProfileBearer: () => {
    throw new Error("Unexpected auth-profile transport in MCP runtime test");
  },
}));

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
beforeEach(async () => {
  await testing.resetSessionMcpRuntimeManager();
  Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
  await bindSessionMcpRuntimeTestScheduler();
});
const tempDirTracker = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await testing.resetSessionMcpRuntimeManager();
    Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
    cleanup();
  });
});

it("reconnects after an MCP child process exits", async ({ signal }) => {
  const tempDir = tempDirTracker.make("bundle-mcp-child-exit-");
  const serverPath = path.join(tempDir, "server.mjs");
  const logPath = path.join(tempDir, "server.log");
  const pidPath = path.join(tempDir, "server.pid");
  const listToolsReleasePath = path.join(tempDir, "list-tools.release");
  const healthyServerPath = path.join(tempDir, "healthy.mjs");
  const healthyLogPath = path.join(tempDir, "healthy.log");
  await fs.writeFile(listToolsReleasePath, "release", "utf8");
  await writeListToolsMcpServer(
    {
      filePath: serverPath,
      logPath,
      pidPath,
      listToolsReleasePath,
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
    receipts.endpoint,
  );
  await writeListToolsMcpServer(
    { filePath: healthyServerPath, logPath: healthyLogPath },
    receipts.endpoint,
  );

  const runtime = await getOrCreateSessionMcpRuntime({
    sessionId: "session-child-exit",
    sessionKey: "agent:test:session-child-exit",
    workspaceDir: "/workspace",
    cfg: {
      mcp: {
        servers: {
          child: { command: process.execPath, args: [serverPath] },
          healthy: { command: process.execPath, args: [healthyServerPath] },
        },
      },
    },
  });

  try {
    await runtime.getCatalog();
    await expect(runtime.callTool("child", "slow_tool", {})).resolves.toMatchObject({
      isError: false,
    });
    const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
    await fs.rm(listToolsReleasePath, { force: true });
    // SIGKILL rather than the default SIGTERM: this test is about what happens once the
    // child is actually gone, so the kill must not race the assertions below.
    process.kill(pid, "SIGKILL");

    await waitForRuntimeState(
      () =>
        runtime
          .peekCatalog()
          ?.diagnostics?.some(
            (entry) => entry.serverName === "child" && entry.message === "mcp transport closed",
          ) === true,
      "closed transport to schedule a catalog retry",
      signal,
    );
    // Background recovery may still hold the closed session or already have retired it.
    // Both states must reject while the replacement catalog remains blocked.
    await expect(runtime.callTool("child", "slow_tool", {})).rejects.toThrow(
      /^bundle-mcp server "child" is (?:not connected|disconnected: mcp transport closed)$/,
    );
    await withinTest(receipts.waitFor(logPath, "recv tools/list", 2), signal);
    const recoveringTools = await materializeBundleMcpToolsForRun({ runtime });
    try {
      expect(recoveringTools.tools.map((tool) => tool.name)).toEqual(["healthy__slow_tool"]);
      expect(recoveringTools.diagnostics).toEqual([
        expect.objectContaining({ serverName: "child", message: "mcp transport closed" }),
      ]);
    } finally {
      await recoveringTools.dispose();
    }
    await expect(
      withinTest(runtime.callTool("healthy", "slow_tool", {}), signal),
    ).resolves.toMatchObject({ isError: false });
    await fs.writeFile(listToolsReleasePath, "release", "utf8");
    await waitForRuntimeState(
      async () => {
        try {
          return (await runtime.callTool("child", "slow_tool", {})).isError === false;
        } catch {
          return false;
        }
      },
      "child server to reconnect",
      signal,
    );
    const replacementPid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
    expect(Number.isFinite(replacementPid)).toBe(true);
    expect(replacementPid).not.toBe(pid);
  } finally {
    await runtime.dispose();
  }
});
