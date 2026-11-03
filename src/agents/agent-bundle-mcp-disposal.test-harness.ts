import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { testing } from "./agent-bundle-mcp-runtime.js";
import type { writeListToolsMcpServer as writeServer } from "./agent-bundle-mcp-stdio.test-support.js";
import { retireSessionMcpRuntime } from "./agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

export function registerMcpDisposalTimeoutCase({
  writeListToolsMcpServer,
  makeStdioRuntime,
}: {
  writeListToolsMcpServer: (params: Parameters<typeof writeServer>[0]) => Promise<void>;
  makeStdioRuntime: (
    sessionId: string,
    serverName: string,
    serverPath: string,
  ) => Promise<SessionMcpRuntime>;
}): void {
  it(
    "completes disposal even when the MCP server process ignores shutdown",
    { timeout: 15_000 },
    async () => {
      testing.setBundleMcpDisposeTimeoutMsForTest(50);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-dispose-timeout-"));
      const serverPath = path.join(tempDir, "hanging-close.mjs");
      const logPath = path.join(tempDir, "server.log");

      await writeListToolsMcpServer({
        filePath: serverPath,
        logPath,
        ignoreShutdown: true,
      });

      const runtime = await makeStdioRuntime("session-dispose-timeout", "hangingClose", serverPath);

      const catalog = await runtime.getCatalog();
      expect(catalog.tools).toHaveLength(1);

      const start = Date.now();
      await runtime.dispose();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1_000);

      await retireSessionMcpRuntime({
        sessionId: "session-dispose-timeout",
        reason: "test cleanup",
      });
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  );
}
