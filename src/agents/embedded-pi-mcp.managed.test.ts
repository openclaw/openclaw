import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("loadEmbeddedPiMcpConfig managed MCP", () => {
  it("merges managed MCP servers before top-level configured MCP servers", () => {
    const registry = createEmptyPluginRegistry();
    registry.managedMcpServers.push({
      pluginId: "openai",
      pluginName: "OpenAI Provider",
      source: "test",
      server: {
        name: "openai-chatgpt-apps",
        config: ({ workspaceDir }) => ({
          command: "node",
          args: [workspaceDir ?? "missing-workspace"],
        }),
      },
    });
    setActivePluginRegistry(registry, "managed-mcp-test");

    const loaded = loadEmbeddedPiMcpConfig({
      workspaceDir: "/tmp/openclaw-workspace",
      cfg: {
        mcp: {
          servers: {
            docs: {
              url: "https://example.com/mcp",
            },
          },
        },
      },
    });

    expect(loaded.mcpServers).toEqual({
      "openai-chatgpt-apps": {
        command: "node",
        args: ["/tmp/openclaw-workspace"],
      },
      docs: {
        url: "https://example.com/mcp",
      },
    });
  });

  it("lets top-level configured MCP servers override managed registrations", () => {
    const registry = createEmptyPluginRegistry();
    registry.managedMcpServers.push({
      pluginId: "openai",
      pluginName: "OpenAI Provider",
      source: "test",
      server: {
        name: "shared",
        config: {
          command: "node",
          args: ["managed.mjs"],
        },
      },
    });
    setActivePluginRegistry(registry, "managed-mcp-override-test");

    const loaded = loadEmbeddedPiMcpConfig({
      workspaceDir: "/tmp/openclaw-workspace",
      cfg: {
        mcp: {
          servers: {
            shared: {
              url: "https://example.com/mcp",
            },
          },
        },
      },
    });

    expect(loaded.mcpServers).toEqual({
      shared: {
        url: "https://example.com/mcp",
      },
    });
  });
});
