import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client, SdkErrorCode } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { connectMcpClient, disposeMcpClient } from "./mcp-client-lifecycle.js";
import { McpStdioFrameDecoder } from "./mcp-stdio-frame-decoder.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { observeNativeMcpProbe } from "./native-mcp-connect.js";

const require = createRequire(import.meta.url);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("native MCP supervised era probe", () => {
  it.each(["legacy-exit", "oversize"] as const)(
    "restarts only an upstream that exits on the unknown probe (%s)",
    async (mode) => {
      const root = tempDirs.make("native-mcp-era-");
      const serverPath = path.join(root, "server.mjs");
      const startsPath = path.join(root, "starts");
      await fs.writeFile(
        serverPath,
        `import fs from "node:fs";
import { McpServer } from ${JSON.stringify(require.resolve("@modelcontextprotocol/server"))};
import { StdioServerTransport } from ${JSON.stringify(require.resolve("@modelcontextprotocol/server/stdio"))};
fs.appendFileSync(${JSON.stringify(startsPath)}, String(process.pid) + "\\n");
const server = new McpServer({ name: "probe-fixture", version: "1" });
server.registerTool("echo", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "legacy connected" }] }));
const transport = new StdioServerTransport();
await server.connect(transport);
const receive = transport.onmessage;
transport.onmessage = (message) => {
  if (message.method === "server/discover") {
    if (${JSON.stringify(mode)} === "legacy-exit") process.exit(23);
    process.stdout.write("x".repeat(256) + "\\n");
    return;
  }
  receive(message);
};`,
      );
      const createSession = (legacy = false) => {
        const client = new Client(
          { name: "probe-test", version: "1" },
          { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
        );
        const transport = new OpenClawStdioClientTransport({
          command: process.execPath,
          args: [serverPath],
          ...(mode === "oversize" ? { decoder: new McpStdioFrameDecoder(128, "transport") } : {}),
        });
        transport.stderr.resume();
        return { client, transport, transportType: "stdio" as const };
      };
      const session = createSession();
      const probe = observeNativeMcpProbe(session.transport);
      let connectError: unknown;
      try {
        await connectMcpClient({ ...session, timeoutMs: 5_000 });
      } catch (error) {
        connectError = error;
      }
      const canRestart = probe.canRestartLegacy(connectError);
      probe.detach();
      expect(await disposeMcpClient(session)).toBe("closed");
      expect(connectError).toMatchObject({ code: SdkErrorCode.EraNegotiationFailed });
      expect(canRestart).toBe(mode === "legacy-exit");

      if (canRestart) {
        const retained = createSession(true);
        try {
          await connectMcpClient({ ...retained, timeoutMs: 5_000 });
          expect(retained.client.getProtocolEra()).toBe("legacy");
          expect(await retained.client.callTool({ name: "echo", arguments: {} })).toMatchObject({
            content: [{ type: "text", text: "legacy connected" }],
          });
        } finally {
          expect(await disposeMcpClient(retained)).toBe("closed");
        }
      }
      const pids = (await fs.readFile(startsPath, "utf8")).trim().split("\n").map(Number);
      expect(pids).toHaveLength(mode === "legacy-exit" ? 2 : 1);
      for (const pid of pids) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    },
  );
});
