import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  createBundleMcpToolRuntime,
  disposeSessionMcpRuntime,
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-tools.js";

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

async function writeBundleProbeMcpServer(
  filePath: string,
  params: { startupCounterPath?: string } = {},
): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import { McpServer } from ${JSON.stringify(SDK_SERVER_MCP_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SDK_SERVER_STDIO_PATH)};

const startupCounterPath = ${JSON.stringify(params.startupCounterPath ?? "")};
if (startupCounterPath) {
  let current = 0;
  try {
    current = Number.parseInt((await fs.readFile(startupCounterPath, "utf8")).trim(), 10) || 0;
  } catch {}
  await fs.writeFile(startupCounterPath, String(current + 1), "utf8");
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
    expect(materializedA.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
    expect(materializedB.tools.map((tool) => tool.name)).toEqual(["bundle_probe"]);
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
});
