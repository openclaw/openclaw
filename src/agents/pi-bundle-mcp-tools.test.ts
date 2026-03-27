import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBundleProbeMcpServer, writeClaudeBundle } from "./bundle-mcp.test-harness.js";
import { createBundleMcpToolRuntime } from "./pi-bundle-mcp-tools.js";

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

describe("createBundleMcpToolRuntime — HTTP config detection", () => {
  it("skips server with both command and url", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-http-");
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            conflicted: {
              command: "node",
              url: "http://localhost:9999/mcp",
              transport: "sse",
            },
          },
        },
      },
    });
    try {
      expect(runtime.tools).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("skips HTTP server with missing transport field", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-http-");
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            noTransport: {
              url: "http://localhost:9999/mcp",
            },
          },
        },
      },
    });
    try {
      expect(runtime.tools).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("skips HTTP server with unrecognized transport value", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-http-");
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            badTransport: {
              url: "http://localhost:9999/mcp",
              transport: "websocket",
            },
          },
        },
      },
    });
    try {
      expect(runtime.tools).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("skips HTTP server with invalid URL", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-http-");
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            badUrl: {
              url: "not-a-valid-url",
              transport: "sse",
            },
          },
        },
      },
    });
    try {
      expect(runtime.tools).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("skips HTTP server that is unreachable at startup", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-http-");
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            unreachable: {
              url: "http://127.0.0.1:19999/mcp",
              transport: "sse",
            },
          },
        },
      },
    });
    try {
      // Server unreachable — tools list should be empty, gateway should not crash
      expect(runtime.tools).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
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
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe:bundle_probe"]);
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
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["configuredProbe:bundle_probe"]);
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
