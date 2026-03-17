import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { captureEnv } from "../test-utils/env.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { loadEnabledBundlePiSettingsSnapshot } from "./pi-project-settings.js";

const tempDirs = createTrackedTempDirs();

async function createHomeAndWorkspace() {
  const homeDir = await tempDirs.make("openclaw-bundle-home-");
  const workspaceDir = await tempDirs.make("openclaw-workspace-");
  return { homeDir, workspaceDir };
}

async function createClaudeBundlePlugin(params: {
  homeDir: string;
  pluginId: string;
  pluginJson?: Record<string, unknown>;
  settingsJson?: Record<string, unknown>;
  mcpJson?: Record<string, unknown>;
}) {
  const pluginRoot = path.join(params.homeDir, ".openclaw", "extensions", params.pluginId);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: params.pluginId, ...params.pluginJson }, null, 2)}\n`,
    "utf-8",
  );
  if (params.settingsJson) {
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      `${JSON.stringify(params.settingsJson, null, 2)}\n`,
      "utf-8",
    );
  }
  if (params.mcpJson) {
    await fs.mkdir(path.join(pluginRoot, "servers"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      `${JSON.stringify(params.mcpJson, null, 2)}\n`,
      "utf-8",
    );
  }
  return pluginRoot;
}

afterEach(async () => {
  clearPluginManifestRegistryCache();
  await tempDirs.cleanup();
});

describe("loadEnabledBundlePiSettingsSnapshot", () => {
  it("loads sanitized settings from enabled bundle plugins", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const { homeDir, workspaceDir } = await createHomeAndWorkspace();
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      await createClaudeBundlePlugin({
        homeDir,
        pluginId: "claude-bundle",
        settingsJson: {
          hideThinkingBlock: true,
          shellPath: "/tmp/blocked-shell",
          compaction: { keepRecentTokens: 64_000 },
        },
      });

      const snapshot = loadEnabledBundlePiSettingsSnapshot({
        cwd: workspaceDir,
        cfg: {
          plugins: {
            entries: {
              "claude-bundle": { enabled: true },
            },
          },
        },
      });

      expect(snapshot.hideThinkingBlock).toBe(true);
      expect(snapshot.shellPath).toBeUndefined();
      expect(snapshot.compaction?.keepRecentTokens).toBe(64_000);
    } finally {
      env.restore();
    }
  });

  it("loads enabled bundle MCP servers into the Pi settings snapshot", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const { homeDir, workspaceDir } = await createHomeAndWorkspace();
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      const pluginRoot = await createClaudeBundlePlugin({
        homeDir,
        pluginId: "claude-bundle",
        mcpJson: {
          mcpServers: {
            bundleProbe: {
              command: "node",
              args: ["./servers/probe.mjs"],
            },
          },
        },
      });

      const snapshot = loadEnabledBundlePiSettingsSnapshot({
        cwd: workspaceDir,
        cfg: {
          plugins: {
            entries: {
              "claude-bundle": { enabled: true },
            },
          },
        },
      });
      const resolvedPluginRoot = await fs.realpath(pluginRoot);

      expect(snapshot.mcpServers).toEqual({
        bundleProbe: {
          command: "node",
          args: [path.join(resolvedPluginRoot, "servers", "probe.mjs")],
          cwd: resolvedPluginRoot,
        },
      });
    } finally {
      env.restore();
    }
  });

  it("lets top-level MCP config override bundle MCP defaults", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const { homeDir, workspaceDir } = await createHomeAndWorkspace();
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      await createClaudeBundlePlugin({
        homeDir,
        pluginId: "claude-bundle",
        mcpJson: {
          mcpServers: {
            sharedServer: {
              command: "node",
              args: ["./servers/bundle.mjs"],
            },
          },
        },
      });

      const snapshot = loadEnabledBundlePiSettingsSnapshot({
        cwd: workspaceDir,
        cfg: {
          mcp: {
            servers: {
              sharedServer: {
                url: "https://example.com/mcp",
              },
            },
          },
          plugins: {
            entries: {
              "claude-bundle": { enabled: true },
            },
          },
        },
      });

      expect(snapshot.mcpServers).toEqual({
        sharedServer: {
          url: "https://example.com/mcp",
        },
      });
    } finally {
      env.restore();
    }
  });

  it("ignores disabled bundle plugins", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const { homeDir, workspaceDir } = await createHomeAndWorkspace();
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      await createClaudeBundlePlugin({
        homeDir,
        pluginId: "claude-bundle",
        settingsJson: {
          hideThinkingBlock: true,
        },
      });

      const snapshot = loadEnabledBundlePiSettingsSnapshot({
        cwd: workspaceDir,
        cfg: {
          plugins: {
            entries: {
              "claude-bundle": { enabled: false },
            },
          },
        },
      });

      expect(snapshot).toEqual({});
    } finally {
      env.restore();
    }
  });
});
