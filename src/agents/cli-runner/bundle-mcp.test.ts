import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
} from "../../plugins/bundle-mcp.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { captureEnv } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  await tempHarness.cleanup();
});

describe("prepareCliBundleMcpConfig", () => {
  it("injects a merged --mcp-config overlay for claude-cli", async () => {
    const env = captureEnv(["HOME"]);
    try {
      const homeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
      const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
      process.env.HOME = homeDir;

      const { serverPath } = await createBundleProbePlugin(homeDir);

      const config: OpenClawConfig = {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      const prepared = await prepareCliBundleMcpConfig({
        backendId: "claude-cli",
        backend: {
          command: "node",
          args: ["./fake-claude.mjs"],
        },
        workspaceDir,
        config,
      });

      const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
      expect(configFlagIndex).toBeGreaterThanOrEqual(0);
      expect(prepared.backend.args).toContain("--strict-mcp-config");
      const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
      expect(typeof generatedConfigPath).toBe("string");
      const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
        mcpServers?: Record<string, { args?: string[] }>;
      };
      expect(raw.mcpServers?.bundleProbe?.args).toEqual([await fs.realpath(serverPath)]);

      await prepared.cleanup?.();
    } finally {
      env.restore();
    }
  });

  it("includes managed MCP servers in the generated claude-cli overlay", async () => {
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
    setActivePluginRegistry(registry, "managed-cli-mcp-test");

    const prepared = await prepareCliBundleMcpConfig({
      backendId: "claude-cli",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir: "/tmp/openclaw-workspace",
      config: {} satisfies OpenClawConfig,
    });

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    expect(configFlagIndex).toBeGreaterThanOrEqual(0);
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    expect(typeof generatedConfigPath).toBe("string");
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(raw.mcpServers?.["openai-chatgpt-apps"]).toEqual({
      command: "node",
      args: ["/tmp/openclaw-workspace"],
    });

    await prepared.cleanup?.();
  });
});
