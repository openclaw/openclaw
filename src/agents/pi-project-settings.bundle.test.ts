import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const hoisted = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => hoisted.loadPluginManifestRegistry(...args),
}));

const { loadEnabledBundlePiSettingsSnapshot } = await import("./pi-project-settings.js");

const tempDirs = createTrackedTempDirs();

function buildRegistry(params: {
  pluginRoot: string;
  settingsFiles?: string[];
}): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "claude-bundle",
        name: "Claude Bundle",
        format: "bundle",
        bundleFormat: "claude",
        bundleCapabilities: ["settings"],
        channels: [],
        providers: [],
        skills: [],
        settingsFiles: params.settingsFiles ?? ["settings.json"],
        hooks: [],
        origin: "workspace",
        rootDir: params.pluginRoot,
        source: params.pluginRoot,
        manifestPath: path.join(params.pluginRoot, ".claude-plugin", "plugin.json"),
      },
    ],
  };
}

afterEach(async () => {
  hoisted.loadPluginManifestRegistry.mockReset();
  await tempDirs.cleanup();
});

describe("loadEnabledBundlePiSettingsSnapshot", () => {
  it("loads sanitized settings from enabled bundle plugins", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await tempDirs.make("openclaw-bundle-");
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      JSON.stringify({
        hideThinkingBlock: true,
        shellPath: "/tmp/blocked-shell",
        compaction: { keepRecentTokens: 64_000 },
      }),
      "utf-8",
    );
    hoisted.loadPluginManifestRegistry.mockReturnValue(buildRegistry({ pluginRoot }));

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
  });

  it("loads enabled bundle MCP servers into the Pi settings snapshot", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await tempDirs.make("openclaw-bundle-");
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "servers"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "claude-bundle",
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          bundleProbe: {
            command: "node",
            args: ["./servers/probe.mjs"],
          },
        },
      }),
      "utf-8",
    );
    hoisted.loadPluginManifestRegistry.mockReturnValue(
      buildRegistry({ pluginRoot, settingsFiles: [] }),
    );

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

    expect(snapshot.mcpServers).toEqual({
      bundleProbe: {
        command: "node",
        args: [path.join(pluginRoot, "servers", "probe.mjs")],
        cwd: pluginRoot,
      },
    });
  });

  it("lets top-level MCP config override bundle MCP defaults", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await tempDirs.make("openclaw-bundle-");
    await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "claude-bundle",
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          sharedServer: {
            command: "node",
            args: ["./servers/bundle.mjs"],
          },
        },
      }),
      "utf-8",
    );
    hoisted.loadPluginManifestRegistry.mockReturnValue(
      buildRegistry({ pluginRoot, settingsFiles: [] }),
    );

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
  });

  it("ignores disabled bundle plugins", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await tempDirs.make("openclaw-bundle-");
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      JSON.stringify({ hideThinkingBlock: true }),
      "utf-8",
    );
    hoisted.loadPluginManifestRegistry.mockReturnValue(buildRegistry({ pluginRoot }));

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
  });
});
