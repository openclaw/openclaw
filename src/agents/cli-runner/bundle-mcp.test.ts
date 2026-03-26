import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
} from "../../plugins/bundle-mcp.test-support.js";
import { captureEnv } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

describe("prepareCliBundleMcpConfig", () => {
  it("injects a merged --mcp-config overlay for bundle-MCP-enabled backends", async () => {
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
        enabled: true,
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
      expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);

      await prepared.cleanup?.();
    } finally {
      env.restore();
    }
  });

  it("leaves args untouched when bundle MCP is disabled", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      backend: {
        command: "node",
        args: ["./fake-cli.mjs"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-disabled",
    });

    expect(prepared.backend.args).toEqual(["./fake-cli.mjs"]);
    expect(prepared.cleanup).toBeUndefined();
  });
});
