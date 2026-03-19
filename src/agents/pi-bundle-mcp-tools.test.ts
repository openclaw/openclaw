import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBundleProbeMcpServer, writeClaudeBundle } from "./bundle-mcp.test-harness.js";
import { createBundleMcpToolRuntime } from "./pi-bundle-mcp-tools.js";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const SDK_SERVER_SSE_PATH = require.resolve("@modelcontextprotocol/sdk/server/sse.js");

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createBundledRuntime(options?: { reservedToolNames?: string[] }) {
  const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
  const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
  await writeBundleProbeMcpServer(serverScriptPath);
  await writeClaudeBundle({ pluginRoot, serverScriptPath });

  return createBundleMcpToolRuntime({
    workspaceDir,
    cfg: {
      plugins: {
        entries: {
          "bundle-probe": { enabled: true },
        },
      },
    },
    reservedToolNames: options?.reservedToolNames,
  });
}

describe("createBundleMcpToolRuntime", () => {
  it("loads bundle MCP tools and executes them", async () => {
    const runtime = await createBundledRuntime();

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
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

  it("skips bundle MCP tools that collide with existing tool names", async () => {
    const runtime = await createBundledRuntime({ reservedToolNames: ["bundle_probe"] });

    try {
      expect(runtime.tools).toEqual([]);
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
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
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
    // Dynamically import the SSE server transport from the SDK.
    const { McpServer } = await import(SDK_SERVER_MCP_PATH);
    const { SSEServerTransport } = await import(SDK_SERVER_SSE_PATH);

    const mcpServer = new McpServer({ name: "sse-probe", version: "1.0.0" });
    mcpServer.tool("sse_probe", "SSE MCP probe", async () => {
      return {
        content: [{ type: "text", text: "FROM-SSE" }],
      };
    });

    // Start an HTTP server that hosts the SSE MCP transport.
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
              },
            },
          },
        },
      });

      try {
        expect(runtime.tools.map((tool) => tool.name)).toEqual(["sse_probe"]);
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
      httpServer.close();
    }
  });
});
