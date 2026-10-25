import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const pluginMetadataSnapshotMocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
}));

const bundleTestDeps = vi.hoisted(() => {
  const mcpServers = { bundleProbe: { command: "probe" } };
  return {
    mcpServers,
    loadEmbeddedAgentMcpConfig: vi.fn(() => ({ diagnostics: [], mcpServers })),
  };
});

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot,
}));

vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: bundleTestDeps.loadEmbeddedAgentMcpConfig,
}));

const { loadEnabledBundleAgentSettingsSnapshot } =
  await import("./agent-project-settings-snapshot.js");
const { createPreparedEmbeddedAgentSettingsManager, clearPreparedEmbeddedAgentSettings } =
  await import("./agent-project-settings.js");
const { prepareAgentProviderRetryCount } = await import("./agent-project-settings-prepared.js");

const tempDirs = createTrackedTempDirs();
const bundleConfig = (enabled = true) => ({
  plugins: { entries: { "claude-bundle": { enabled } } },
});
const writeJson = (file: string, value: unknown) =>
  fs.writeFile(file, JSON.stringify(value), "utf-8");

afterEach(async () => {
  await tempDirs.cleanup();
  pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot.mockClear();
  bundleTestDeps.loadEmbeddedAgentMcpConfig.mockClear();
});

async function createWorkspaceBundle(settings: unknown) {
  const workspaceDir = await tempDirs.make("openclaw-workspace-");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "claude-bundle");
  await fs.mkdir(pluginRoot, { recursive: true });
  const pluginMetadataSnapshot = {
    ...createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "claude-bundle",
          origin: "global",
          format: "bundle",
          rootDir: pluginRoot,
          settingsFiles: ["settings.json"],
        },
      ],
    }),
    workspaceDir: "/tmp/gateway-plugin-workspace",
  };
  await writeJson(path.join(pluginRoot, "settings.json"), settings);
  pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot.mockReturnValue(pluginMetadataSnapshot);
  return { workspaceDir, pluginMetadataSnapshot };
}

describe("loadEnabledBundleAgentSettingsSnapshot", () => {
  it("uses the admitted snapshot across workspaces and discovers MCP only for embedding", async () => {
    const { workspaceDir, pluginMetadataSnapshot } = await createWorkspaceBundle({
      hideThinkingBlock: true,
      shellPath: "/tmp/blocked-shell",
      shellCommandPrefix: "echo blocked &&",
      compaction: { keepRecentTokens: 64_000 },
    });

    const snapshot = loadEnabledBundleAgentSettingsSnapshot({
      cwd: workspaceDir,
      cfg: bundleConfig(),
      pluginMetadataSnapshot,
    });

    expect(snapshot).toEqual({ hideThinkingBlock: true, compaction: { keepRecentTokens: 64_000 } });
    expect(pluginMetadataSnapshotMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    const prepared = {
      sessionId: workspaceDir,
      cwd: workspaceDir,
      agentDir: path.join(workspaceDir, "agent"),
      cfg: bundleConfig(),
    };
    expect(prepareAgentProviderRetryCount(prepared)).toBeUndefined();
    expect(bundleTestDeps.loadEmbeddedAgentMcpConfig).not.toHaveBeenCalled();
    const embedded = createPreparedEmbeddedAgentSettingsManager(prepared).getGlobalSettings();
    expect((embedded as Record<string, unknown>).mcpServers).toEqual(bundleTestDeps.mcpServers);

    clearPreparedEmbeddedAgentSettings([workspaceDir]);
  });

  it("ignores disabled bundle plugins", async () => {
    const { workspaceDir } = await createWorkspaceBundle({ hideThinkingBlock: true });

    const snapshot = loadEnabledBundleAgentSettingsSnapshot({
      cwd: workspaceDir,
      cfg: bundleConfig(false),
    });

    expect(snapshot).toStrictEqual({});
  });
});
