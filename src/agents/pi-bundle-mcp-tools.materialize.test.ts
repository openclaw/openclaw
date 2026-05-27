import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupBundleMcpHarness,
  makeTempDir,
  startSseProbeServer,
  writeBundleProbeMcpServer,
  writeClaudeBundle,
} from "./pi-bundle-mcp-test-harness.js";
import { createBundleMcpToolRuntime } from "./pi-bundle-mcp-tools.js";

afterEach(async () => {
  await cleanupBundleMcpHarness();
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
    const sseServer = await startSseProbeServer();

    try {
      const workspaceDir = await makeTempDir("openclaw-bundle-mcp-sse-");
      const runtime = await createBundleMcpToolRuntime({
        workspaceDir,
        cfg: {
          mcp: {
            servers: {
              sseProbe: {
                url: `http://127.0.0.1:${sseServer.port}/sse`,
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
      await sseServer.close();
    }
  });
});
