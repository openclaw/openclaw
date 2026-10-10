import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import {
  waitForRuntimeState,
  writeListToolsMcpServer as writeListToolsMcpServerFixture,
} from "./agent-bundle-mcp-stdio.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

it("reconnects after an MCP child process exits", async ({ signal }) => {
  const tempDir = tempDirs.make("bundle-mcp-child-exit-");
  const serverPath = path.join(tempDir, "server.mjs");
  const logPath = path.join(tempDir, "server.log");
  const pidPath = path.join(tempDir, "server.pid");
  const listToolsReleasePath = path.join(tempDir, "list-tools.release");
  const healthyServerPath = path.join(tempDir, "healthy.mjs");
  const healthyLogPath = path.join(tempDir, "healthy.log");
  await fs.writeFile(listToolsReleasePath, "release", "utf8");
  await writeListToolsMcpServerFixture(
    {
      filePath: serverPath,
      logPath,
      pidPath,
      listToolsReleasePath,
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
    receipts.endpoint,
  );
  await writeListToolsMcpServerFixture(
    { filePath: healthyServerPath, logPath: healthyLogPath },
    receipts.endpoint,
  );

  const runtime = createSessionMcpRuntime({
    sessionId: "session-child-exit",
    sessionKey: "agent:test:session-child-exit",
    workspaceDir: "/workspace",
    cfg: {
      plugins: { enabled: false },
      mcp: {
        servers: {
          child: { command: process.execPath, args: [serverPath] },
          healthy: { command: process.execPath, args: [healthyServerPath] },
        },
      },
    },
  });

  try {
    const originalTools = await materializeBundleMcpToolsForRun({ runtime });
    const originalBytes = JSON.stringify(
      originalTools.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    );
    await originalTools.dispose();
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
    await expect(runtime.callTool("child", "slow_tool", {})).rejects.toThrow(
      'bundle-mcp server "child" is not connected',
    );
    const recoveringTools = await materializeBundleMcpToolsForRun({ runtime });
    try {
      expect(
        JSON.stringify(
          recoveringTools.tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
        ),
      ).toBe(originalBytes);
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
    await runtime.joinCleanup?.();
  }
});
