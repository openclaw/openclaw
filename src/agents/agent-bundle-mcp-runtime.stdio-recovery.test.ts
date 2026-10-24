import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processLineage from "../process/supervisor/inherited-process-lineage.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { snapshotMcpTools } from "./agent-bundle-mcp-recovery.test-support.js";
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
afterAll(() => receipts.close());

const config = (servers: Record<string, { command: string; args?: string[] }>) => ({
  plugins: { enabled: false },
  mcp: { servers },
});

it.skipIf(process.platform === "win32")(
  "prepares the same session after removing an unavailable process-group server",
  async () => {
    // Exercise the real two-process owner used by macOS and portable workers.
    vi.spyOn(processLineage, "getInheritedNativeProcessOwner").mockReturnValue(undefined);
    mockProcessPlatform("darwin");
    const workspaceDir = tempDirs.make("bundle-mcp-missing-command-");
    const manager = createSessionMcpRuntimeManager();
    const params = {
      sessionId: "missing-command-recovery",
      sessionKey: "agent:test:missing-command-recovery",
      workspaceDir,
      manifestRegistry: { plugins: [] },
    };
    const cfg = config({ missing: { command: path.join(workspaceDir, "absent-executable") } });
    let release: (() => void) | undefined;
    try {
      const original = await manager.acquire({ ...params, cfg });
      release = original.releaseLease;
      await expect(original.runtime.getCatalog()).resolves.toMatchObject({
        diagnostics: [{ serverName: "missing", message: expect.stringContaining("ENOENT") }],
      });
      release();
      release = undefined;

      const removed = config({});
      await manager.reloadConfig({ cfg: removed, manifestRegistry: params.manifestRegistry });
      const next = await manager.acquire({ ...params, cfg: removed });
      release = next.releaseLease;
      const prepared = await snapshotMcpTools(next);
      release = undefined;
      expect(prepared).toEqual({ bytes: "[]", diagnostics: [] });
    } finally {
      release?.();
      await manager.disposeAll().finally(() => vi.restoreAllMocks());
    }
  },
);

it("reconnects after an MCP child process exits", async ({ signal }) => {
  const tempDir = tempDirs.make("bundle-mcp-child-exit-");
  async function server(
    name: string,
    options: Omit<
      Parameters<typeof writeListToolsMcpServerFixture>[0],
      "filePath" | "logPath"
    > = {},
  ) {
    const fixture = {
      ...options,
      filePath: path.join(tempDir, `${name}.mjs`),
      logPath: path.join(tempDir, `${name}.log`),
    };
    await writeListToolsMcpServerFixture(fixture, receipts.endpoint);
    return { ...fixture, launch: { command: process.execPath, args: [fixture.filePath] } };
  }
  const pidPath = path.join(tempDir, "server.pid");
  const listToolsReleasePath = path.join(tempDir, "list-tools.release");
  await fs.writeFile(listToolsReleasePath, "release", "utf8");
  const child = await server("server", {
    pidPath,
    listToolsReleasePath,
    capabilities: { tools: {}, resources: {}, prompts: {} },
  });
  const healthy = await server("healthy");

  const runtime = createSessionMcpRuntime({
    sessionId: "session-child-exit",
    sessionKey: "agent:test:session-child-exit",
    workspaceDir: "/workspace",
    cfg: config({ child: child.launch, healthy: healthy.launch }),
  });
  const call = (serverName: string) => runtime.callTool(serverName, "slow_tool", {});

  try {
    const { bytes: originalBytes } = await snapshotMcpTools({ runtime });
    await expect(call("child")).resolves.toMatchObject({ isError: false });
    const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
    await fs.rm(listToolsReleasePath, { force: true });
    // SIGTERM can leave the child racing recovery; kill it completely before asserting.
    process.kill(pid, "SIGKILL");

    await waitForRuntimeState(
      () =>
        runtime
          .peekCatalog()
          ?.diagnostics?.some(
            ({ serverName, message }) =>
              serverName === "child" && message === "mcp transport closed",
          ) ?? false,
      "closed transport to schedule a catalog retry",
      signal,
    );
    // Both closed and retired sessions must reject while the replacement catalog is blocked.
    await expect(call("child")).rejects.toThrow(
      /^bundle-mcp server "child" is (?:not connected|disconnected: mcp transport closed)$/,
    );
    await withinTest(receipts.waitFor(child.logPath, "recv tools/list", 2), signal);
    await expect(call("child")).rejects.toThrow('bundle-mcp server "child" is not connected');
    const recoveringTools = await snapshotMcpTools({ runtime });
    expect(recoveringTools).toMatchObject({
      bytes: originalBytes,
      diagnostics: [{ serverName: "child", message: "mcp transport closed" }],
    });
    await expect(withinTest(call("healthy"), signal)).resolves.toMatchObject({ isError: false });
    await fs.writeFile(listToolsReleasePath, "release", "utf8");
    await waitForRuntimeState(
      async () => (await call("child").catch(() => undefined))?.isError === false,
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
