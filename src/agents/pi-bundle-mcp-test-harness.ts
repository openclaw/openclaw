import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { __testing } from "./pi-bundle-mcp-tools.js";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_SSE_PATH = require.resolve("@modelcontextprotocol/sdk/server/sse.js");
const SDK_SERVER_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");

const tempDirs: string[] = [];

export async function cleanupBundleMcpHarness(): Promise<void> {
  await __testing.resetSessionMcpRuntimeManager();
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

export async function writeBundleProbeMcpServer(
  filePath: string,
  params: {
    startupCounterPath?: string;
    startupDelayMs?: number;
    pidPath?: string;
    exitMarkerPath?: string;
  } = {},
): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from ${JSON.stringify(SDK_SERVER_MCP_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SDK_SERVER_STDIO_PATH)};

const startupCounterPath = ${JSON.stringify(params.startupCounterPath ?? "")};
if (startupCounterPath) {
  let current = 0;
  try {
    current = Number.parseInt((await fsp.readFile(startupCounterPath, "utf8")).trim(), 10) || 0;
  } catch {}
  await fsp.writeFile(startupCounterPath, String(current + 1), "utf8");
}
const pidPath = ${JSON.stringify(params.pidPath ?? "")};
if (pidPath) {
  await fsp.writeFile(pidPath, String(process.pid), "utf8");
}
const exitMarkerPath = ${JSON.stringify(params.exitMarkerPath ?? "")};
if (exitMarkerPath) {
  process.once("exit", () => {
    try {
      fs.writeFileSync(exitMarkerPath, "exited", "utf8");
    } catch {}
  });
}
const startupDelayMs = ${JSON.stringify(params.startupDelayMs ?? 0)};
if (startupDelayMs > 0) {
  await delay(startupDelayMs);
}

const server = new McpServer({ name: "bundle-probe", version: "1.0.0" });
server.tool("bundle_probe", "Bundle MCP probe", async () => {
  return {
    content: [{ type: "text", text: process.env.BUNDLE_PROBE_TEXT ?? "missing-probe-text" }],
  };
});

await server.connect(new StdioServerTransport());
`,
  );
}

export async function waitForFileText(filePath: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await fs.readFile(filePath, "utf8").catch(() => undefined);
    if (content != null) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

export async function writeClaudeBundle(params: {
  pluginRoot: string;
  serverScriptPath: string;
}): Promise<void> {
  await fs.mkdir(path.join(params.pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(params.pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "bundle-probe" }, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(params.pluginRoot, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          bundleProbe: {
            command: "node",
            args: [path.relative(params.pluginRoot, params.serverScriptPath)],
            env: {
              BUNDLE_PROBE_TEXT: "FROM-BUNDLE",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

export async function startSseProbeServer(
  probeText = "FROM-SSE",
): Promise<{ port: number; close: () => Promise<void> }> {
  const { McpServer } = await import(SDK_SERVER_MCP_PATH);
  const { SSEServerTransport } = await import(SDK_SERVER_SSE_PATH);

  const mcpServer = new McpServer({ name: "sse-probe", version: "1.0.0" });
  mcpServer.tool("sse_probe", "SSE MCP probe", async () => {
    return {
      content: [{ type: "text", text: probeText }],
    };
  });

  let sseTransport:
    | {
        handlePostMessage: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
      }
    | undefined;
  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/sse") {
      sseTransport = new SSEServerTransport("/messages", res);
      await mcpServer.connect(sseTransport);
    } else if (req.url?.startsWith("/messages") && req.method === "POST") {
      if (sseTransport) {
        await sseTransport.handlePostMessage(req, res);
      } else {
        res.writeHead(400).end("No SSE session");
      }
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
