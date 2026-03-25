import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundleMcpToolRuntime } from "./pi-bundle-mcp-tools.js";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
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

async function writeBundleProbeMcpServer(filePath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(SDK_SERVER_MCP_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SDK_SERVER_STDIO_PATH)};

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
      reservedToolNames: ["bundle_probe"],
    });

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
});
