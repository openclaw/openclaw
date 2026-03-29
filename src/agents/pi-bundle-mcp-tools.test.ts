import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createBundleMcpToolRuntime,
  disposeSessionMcpRuntime,
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-tools.js";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_SSE_PATH = require.resolve("@modelcontextprotocol/sdk/server/sse.js");
const SDK_SERVER_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

async function writeBundleProbeMcpServer(
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

async function waitForFileText(filePath: string, timeoutMs = 5_000): Promise<string> {
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

async function writeClaudeBundle(params: {
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

afterEach(async () => {
  await __testing.resetSessionMcpRuntimeManager();
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("createBundleMcpToolRuntime", () => {
  it("loads bundle MCP tools and executes them", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath);
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
      const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-BUNDLE",
      });
      expect(result.details).toEqual({
        mcpServer: "bundleProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("disambiguates bundle MCP tools that collide with existing tool names", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath);
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
      reservedToolNames: ["bundleProbe__bundle_probe"],
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("loads configured stdio MCP tools without a bundle", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const serverScriptPath = path.join(workspaceDir, "servers", "configured-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath);

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG",
              },
            },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["configuredProbe__bundle_probe"]);
      const result = await runtime.tools[0].execute(
        "call-configured-probe",
        {},
        undefined,
        undefined,
      );
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-CONFIG",
      });
      expect(result.details).toEqual({
        mcpServer: "configuredProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("loads configured SSE MCP tools via url", async () => {
    const { McpServer } = await import(SDK_SERVER_MCP_PATH);
    const { SSEServerTransport } = await import(SDK_SERVER_SSE_PATH);

    const mcpServer = new McpServer({ name: "sse-probe", version: "1.0.0" });
    mcpServer.tool("sse_probe", "SSE MCP probe", async () => {
      return {
        content: [{ type: "text", text: "FROM-SSE" }],
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
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const workspaceDir = await makeTempDir("openclaw-bundle-mcp-sse-");
      const runtime = await createBundleMcpToolRuntime({
        workspaceDir,
        cfg: {
          mcp: {
            servers: {
              sseProbe: {
                url: `http://127.0.0.1:${port}/sse`,
                transport: "sse",
              },
            },
          },
        },
      });

      try {
        expect(runtime.tools.map((tool) => tool.name)).toEqual(["sseProbe__sse_probe"]);
        const result = await runtime.tools[0].execute("call-sse-probe", {}, undefined, undefined);
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: "FROM-SSE",
        });
        expect(result.details).toEqual({
          mcpServer: "sseProbe",
          mcpTool: "sse_probe",
        });
      } finally {
        await runtime.dispose();
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("reuses the same session runtime across repeated materialization", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtimeA = await getOrCreateSessionMcpRuntime({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });
    const runtimeB = await getOrCreateSessionMcpRuntime({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });

    const materializedA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const materializedB = await materializeBundleMcpToolsForRun({
      runtime: runtimeB,
      reservedToolNames: ["builtin_tool"],
    });

    expect(runtimeA).toBe(runtimeB);
    expect(materializedA.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(materializedB.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("1");
    expect(__testing.getCachedSessionIds()).toEqual(["session-a"]);
  });

  it("recreates the session runtime after explicit disposal", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const cfg = {
      plugins: {
        entries: {
          "bundle-probe": { enabled: true },
        },
      },
    };

    const runtimeA = await getOrCreateSessionMcpRuntime({
      sessionId: "session-b",
      sessionKey: "agent:test:session-b",
      workspaceDir,
      cfg,
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    await disposeSessionMcpRuntime("session-b");

    const runtimeB = await getOrCreateSessionMcpRuntime({
      sessionId: "session-b",
      sessionKey: "agent:test:session-b",
      workspaceDir,
      cfg,
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeB });

    expect(runtimeA).not.toBe(runtimeB);
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("2");
  });

  it("recreates the session runtime when MCP config changes", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const serverScriptPath = path.join(workspaceDir, "servers", "configured-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });

    const runtimeA = await getOrCreateSessionMcpRuntime({
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-A",
              },
            },
          },
        },
      },
    });
    const toolsA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const resultA = await toolsA.tools[0].execute(
      "call-configured-probe-a",
      {},
      undefined,
      undefined,
    );

    const runtimeB = await getOrCreateSessionMcpRuntime({
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-B",
              },
            },
          },
        },
      },
    });
    const toolsB = await materializeBundleMcpToolsForRun({ runtime: runtimeB });
    const resultB = await toolsB.tools[0].execute(
      "call-configured-probe-b",
      {},
      undefined,
      undefined,
    );

    expect(runtimeA).not.toBe(runtimeB);
    expect(resultA.content[0]).toMatchObject({ type: "text", text: "FROM-CONFIG-A" });
    expect(resultB.content[0]).toMatchObject({ type: "text", text: "FROM-CONFIG-B" });
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("2");
  });

  it("disposes startup-in-flight runtimes without leaking MCP processes", async () => {
    vi.useRealTimers();
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pidPath = path.join(workspaceDir, "bundle.pid");
    const exitMarkerPath = path.join(workspaceDir, "bundle.exit");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, {
      startupCounterPath,
      startupDelayMs: 1_000,
      pidPath,
      exitMarkerPath,
    });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-d",
      sessionKey: "agent:test:session-d",
      workspaceDir,
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
    });

    const materializeResult = materializeBundleMcpToolsForRun({ runtime }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await waitForFileText(pidPath);
    await disposeSessionMcpRuntime("session-d");

    const result = await materializeResult;
    if (result.status !== "rejected") {
      throw new Error("Expected bundle MCP materialization to reject after disposal");
    }
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/disposed/);
    expect(await waitForFileText(exitMarkerPath)).toBe("exited");
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("1");
    expect(__testing.getCachedSessionIds()).not.toContain("session-d");
  });
});
