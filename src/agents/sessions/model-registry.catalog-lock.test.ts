// Real catalog locks, SQLite storage, and disk-backed registry reads.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { makeEmptyPluginMetadataOwners } from "../../plugins/current-plugin-metadata.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabases } from "../../state/openclaw-agent-db-lifecycle.js";
import { withPluginModelCatalogWriteLock } from "../plugin-model-catalog-lock.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

it("keeps committed inventory during an async write and defers legacy migration", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "openclaw-catalog-reader-"));
  const modelsPath = join(agentDir, "models.json");
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  let writer: Promise<void> | undefined;
  const catalog = (provider: string, modelId: string) =>
    JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: "https://catalog-fixture.invalid/v1",
          models: [{ id: modelId, name: modelId }],
        },
      },
    });
  const owners = new Map([
    ["fixture", ["fixture"]],
    ["legacy", ["legacy"]],
  ]);
  const options = {
    pluginMetadataSnapshot: {
      index: { plugins: ["fixture", "legacy"].map((pluginId) => ({ pluginId, enabled: true })) },
      normalizePluginId: (id: string) => id,
      owners: {
        ...makeEmptyPluginMetadataOwners(),
        providers: owners,
        modelCatalogProviders: owners,
      },
    },
  };
  const catalogKey = encodePluginModelCatalogRelativePath("fixture");
  try {
    writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: { [catalogKey]: catalog("fixture", "committed") },
    });
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, options);
    const legacyPath = join(agentDir, encodePluginModelCatalogRelativePath("legacy"));
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, catalog("legacy", "legacy-model"));

    writer = withPluginModelCatalogWriteLock(agentDir, async () => {
      entered.resolve();
      await resume.promise;
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: { [catalogKey]: catalog("fixture", "published") },
        lockAlreadyHeld: true,
      });
    });
    await Promise.race([entered.promise, writer]);
    const createdDuringWrite = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, options);
    registry.refresh();
    for (const reader of [registry, createdDuringWrite]) {
      expect(reader.getError()).toBeUndefined();
      expect(reader.find("fixture", "committed")).toBeDefined();
      expect(reader.find("fixture", "published")).toBeUndefined();
      expect(reader.find("legacy", "legacy-model")).toBeUndefined();
    }
    expect(existsSync(legacyPath)).toBe(true);

    resume.resolve();
    await writer;
    registry.refresh();
    expect(registry.getError()).toBeUndefined();
    expect(registry.find("fixture", "published")).toBeDefined();
    expect(registry.find("fixture", "committed")).toBeUndefined();
    expect(registry.find("legacy", "legacy-model")).toBeDefined();
    expect(existsSync(legacyPath)).toBe(false);
  } finally {
    resume.resolve();
    try {
      await writer;
    } finally {
      closeOpenClawAgentDatabases(agentDir);
      rmSync(agentDir, { recursive: true, force: true });
    }
  }
});
