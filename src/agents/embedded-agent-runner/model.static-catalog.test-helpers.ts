import type { Mock } from "vitest";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";

export function setManifestPlugins(
  mocks: { listOpenClawPluginManifestMetadata: Mock; loadPluginManifest: Mock },
  plugins: Array<{ id: string; origin?: string }>,
) {
  const byPluginDir = new Map(plugins.map((plugin) => [`/fixtures/${plugin.id}`, plugin]));
  mocks.listOpenClawPluginManifestMetadata.mockReturnValue(
    [...byPluginDir].map(([pluginDir, plugin]) => ({
      pluginDir,
      manifest: plugin,
      origin: plugin.origin,
    })),
  );
  mocks.loadPluginManifest.mockImplementation((pluginDir: string) => {
    const plugin = byPluginDir.get(pluginDir);
    return plugin
      ? { ok: true, manifest: plugin }
      : { ok: false, error: "missing manifest", manifestPath: `${pluginDir}/openclaw.plugin.json` };
  });
}

export function createManifestRecord(
  id: string,
  overrides: Partial<PluginManifestRecord>,
): PluginManifestRecord {
  const rootDir = `/fixtures/${id}`;
  return {
    id,
    origin: "bundled",
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    rootDir,
    source: `${rootDir}/index.ts`,
    manifestPath: `${rootDir}/openclaw.plugin.json`,
    ...overrides,
  };
}
