import fsSync from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { loadEnabledBundleLspConfig } from "../plugins/bundle-lsp.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";
import {
  createBundleMcpTempHarness,
  writeBundleTextFiles,
} from "../plugins/bundle-mcp.test-support.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { loadEnabledBundleAgentSettingsSnapshot } from "./agent-project-settings-snapshot.js";

const tempHarness = createBundleMcpTempHarness();
type SnapshotPlugins = NonNullable<
  Parameters<typeof createPluginMetadataSnapshotFixture>[0]
>["plugins"];

function cachedSnapshot(plugins: SnapshotPlugins, cache = createPluginCache()) {
  return withPluginCache(cache, () => createPluginMetadataSnapshotFixture({ plugins }));
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  await tempHarness.cleanup();
});

async function createBundle() {
  const rootDir = await tempHarness.createTempDir("openclaw-bundle-metadata-cache-");
  const write = (file: string, data: object) =>
    writeBundleTextFiles(rootDir, { [file]: JSON.stringify(data) });
  await write(".claude-plugin/plugin.json", { name: "cache-bundle" });
  await write(".mcp.json", { mcpServers: { bundled: { command: "original" } } });
  await write(".lsp.json", { lspServers: { language: { command: "language" } } });
  await write("settings.json", { hideThinkingBlock: true, shellPath: "/blocked" });
  const cache = createPluginCache();
  const snapshot = cachedSnapshot(
    [
      {
        id: "cache-bundle",
        origin: "global",
        format: "bundle",
        bundleFormat: "claude",
        rootDir,
        settingsFiles: ["settings.json"],
      },
    ],
    cache,
  );
  const cfg = { plugins: { entries: { "cache-bundle": { enabled: true } } } };
  const scope = <T>(current: typeof snapshot, read: () => T) =>
    withPluginMetadataSnapshotScope(current, read, { config: cfg, trustConfigIdentity: true });
  const params = { workspaceDir: rootDir, cfg, manifestRegistry: snapshot.manifestRegistry };
  const settingsParams = { cwd: rootDir, cfg, pluginMetadataSnapshot: snapshot };
  return { write, cache, snapshot, cfg, scope, params, settingsParams };
}

it.each(["provided", "current"] as const)("isolates %s caches", async (registrySource) => {
  const bundle = await createBundle();
  const params = {
    ...bundle.params,
    manifestRegistry: registrySource === "provided" ? bundle.snapshot.manifestRegistry : undefined,
  };
  const read = () => loadSessionMcpConfig(params).loaded.mcpServers.bundled?.command;
  const readOriginal = () => bundle.scope(bundle.snapshot, read);
  expect(readOriginal()).toBe("original");
  await bundle.write(".mcp.json", { mcpServers: { bundled: { command: "replacement" } } });
  const candidate = cachedSnapshot([...bundle.snapshot.plugins]);
  expect([bundle.scope(candidate, read), readOriginal()]).toEqual(["replacement", "original"]);
});

it("reuses bundle file facts across MCP, LSP, settings, and live session policy", async () => {
  const bundle = await createBundle();
  await withPluginCache(bundle.cache, async () => {
    const { params, settingsParams } = bundle;
    loadEnabledBundleMcpConfig(params);
    loadEnabledBundleLspConfig(params);
    loadEnabledBundleAgentSettingsSnapshot(settingsParams);
    loadSessionMcpConfig(params);
    const probes = (
      ["existsSync", "realpathSync", "readFileSync", "readSync", "statSync", "lstatSync"] as const
    ).map((method) => vi.spyOn(fsSync, method));
    const current = loadSessionMcpConfig({
      ...params,
      cfg: { ...bundle.cfg, mcp: { servers: { custom: { command: "custom" } } } },
    });
    expect(current.loaded.mcpServers).toMatchObject({
      bundled: { command: "original" },
      custom: { command: "custom" },
    });
    expect(
      loadSessionMcpConfig({ ...params, toolOverrides: { mcpServers: { bundled: false } } }).loaded
        .mcpServers,
    ).toEqual({});
    expect(loadEnabledBundleMcpConfig(params).config.mcpServers.bundled?.command).toBe("original");
    expect(loadEnabledBundleLspConfig(params).config.lspServers.language?.command).toBe("language");
    const settings = loadEnabledBundleAgentSettingsSnapshot(settingsParams);
    expect([settings.hideThinkingBlock, settings.shellPath]).toEqual([true, undefined]);
    probes.forEach((probe) => expect(probe).not.toHaveBeenCalled());
  });
});

it("reads explicitly supplied settings snapshots from their original plugin cache", async () => {
  const bundle = await createBundle();
  const params = bundle.settingsParams;
  const read = (cache: typeof bundle.cache) =>
    withPluginCache(cache, () => loadEnabledBundleAgentSettingsSnapshot(params).hideThinkingBlock);
  expect(read(bundle.cache)).toBe(true);
  await bundle.write("settings.json", { hideThinkingBlock: false });
  expect(read(createPluginCache())).toBe(true);
});
