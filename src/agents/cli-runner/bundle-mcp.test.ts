import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearPluginManifestRegistryCache } from "../../plugins/manifest-registry.js";
import { captureEnv } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  clearPluginManifestRegistryCache();
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("prepareCliBundleMcpConfig", () => {
  it("injects a merged --mcp-config overlay for claude-cli", async () => {
    const env = captureEnv(["HOME"]);
    try {
      const homeDir = await createTempDir("openclaw-cli-bundle-mcp-home-");
      const workspaceDir = await createTempDir("openclaw-cli-bundle-mcp-workspace-");
      process.env.HOME = homeDir;

      const pluginRoot = path.join(homeDir, ".openclaw", "extensions", "bundle-probe");
      const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
      await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
      await fs.mkdir(path.dirname(serverPath), { recursive: true });
      await fs.writeFile(serverPath, "export {};\n", "utf-8");
      await fs.writeFile(
        path.join(pluginRoot, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: "bundle-probe" }, null, 2)}\n`,
        "utf-8",
      );
      await fs.writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(
          {
            mcpServers: {
              bundleProbe: {
                command: "node",
                args: ["./servers/probe.mjs"],
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

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
});
