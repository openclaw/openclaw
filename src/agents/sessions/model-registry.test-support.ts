/** Shared model registry fixtures with joined agent-database cleanup. */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { replacePersistedPluginModelCatalogs } from "../plugin-model-catalog.js";

export function installModelRegistryTestFixtures() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      for (const dir of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      cleanup();
    }),
  );
  function writeModelsJson(contents: unknown): string {
    const dir = tempDirs.make("openclaw-model-registry-");
    const file = join(dir, "models.json");
    writeFileSync(file, JSON.stringify(contents, null, 2), "utf-8");
    return file;
  }

  function writeModelsJsonWithPluginCatalog(params: {
    root: unknown;
    pluginRelativePath: string;
    pluginCatalog: unknown;
  }): string {
    return writeModelsJsonWithPluginCatalogs({
      root: params.root,
      pluginCatalogs: [
        {
          pluginRelativePath: params.pluginRelativePath,
          pluginCatalog: params.pluginCatalog,
        },
      ],
    });
  }

  function writeModelsJsonWithPluginCatalogs(params: {
    root: unknown;
    pluginCatalogs: Array<{
      pluginRelativePath: string;
      pluginCatalog: unknown;
    }>;
  }): string {
    const file = writeModelsJson(params.root);
    const dir = dirname(file);
    replacePersistedPluginModelCatalogs({
      agentDir: dir,
      pluginCatalogWrites: Object.fromEntries(
        params.pluginCatalogs.map((pluginCatalog) => [
          pluginCatalog.pluginRelativePath,
          JSON.stringify(pluginCatalog.pluginCatalog, null, 2),
        ]),
      ),
    });
    return file;
  }

  return { writeModelsJson, writeModelsJsonWithPluginCatalog, writeModelsJsonWithPluginCatalogs };
}

export function pluginOwnerSnapshot(providerId: string, pluginId: string, enabled = true) {
  return pluginOwnerSnapshotEntries([{ providerId, pluginId, enabled }]);
}

export function pluginOwnerSnapshotEntries(
  entries: Array<{ providerId: string; pluginId: string; enabled?: boolean }>,
) {
  // The registry only trusts generated provider catalogs that are still owned by
  // an enabled plugin in the current metadata snapshot.
  return {
    index: {
      plugins: entries.map((entry) => ({
        pluginId: entry.pluginId,
        enabled: entry.enabled ?? true,
      })),
    },
    normalizePluginId: (id: string) => id,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(entries.map((entry) => [entry.providerId, [entry.pluginId]])),
      modelCatalogProviders: new Map(entries.map((entry) => [entry.providerId, [entry.pluginId]])),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
      modelIdNormalizationPolicies: new Map(),
    },
  };
}
