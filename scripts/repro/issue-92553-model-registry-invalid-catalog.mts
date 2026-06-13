import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const { ModelRegistry } = await import(
  path.join(repoRoot, "src/agents/sessions/model-registry.ts")
);
const { AuthStorage } = await import(path.join(repoRoot, "src/agents/sessions/auth-storage.ts"));
const { PLUGIN_MODEL_CATALOG_FILE, PLUGIN_MODEL_CATALOG_GENERATED_BY } = await import(
  path.join(repoRoot, "src/agents/plugin-model-catalog.ts")
);

function pluginOwnerSnapshot(providerId: string, pluginId: string) {
  return {
    index: {
      plugins: [{ pluginId, enabled: true }],
    },
    normalizePluginId: (id: string) => id,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map([[providerId, [pluginId]]]),
      modelCatalogProviders: new Map([[providerId, [pluginId]]]),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
  };
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-92553-"));
  const modelsJsonPath = path.join(tmpDir, "models.json");
  const badCatalogDir = path.join(tmpDir, "plugins", "bad");
  const badCatalogPath = path.join(badCatalogDir, PLUGIN_MODEL_CATALOG_FILE);

  await fs.writeFile(
    modelsJsonPath,
    JSON.stringify(
      {
        providers: {
          custom: {
            baseUrl: "https://models.example/v1",
            api: "openai-responses",
            apiKey: "CUSTOM_API_KEY",
            models: [{ id: "example-model", name: "Example Model" }],
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  await fs.mkdir(badCatalogDir, { recursive: true });
  await fs.writeFile(
    badCatalogPath,
    JSON.stringify(
      {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          bad: {
            baseUrl: "https://bad.example/v1",
            apiKey: "BAD_API_KEY",
            models: [{ id: "bad-model" }],
          },
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const registry = ModelRegistry.create(
    AuthStorage.inMemory({
      custom: { type: "api_key", key: "sk-test" },
    }),
    modelsJsonPath,
    { pluginMetadataSnapshot: pluginOwnerSnapshot("bad", "bad") },
  );

  const customModel = registry.find("custom", "example-model");
  const badModel = registry.find("bad", "bad-model");

  console.log("=== Reproduction for issue #92553 ===");
  console.log(`models.json: ${modelsJsonPath}`);
  console.log(`bad catalog: ${badCatalogPath}`);
  console.log(`registry error: ${registry.getError() ?? "none"}`);
  console.log(`valid model found: ${customModel?.name ?? "not found"}`);
  console.log(`invalid model found: ${badModel ? "yes (bug)" : "no"}`);

  await fs.rm(tmpDir, { recursive: true, force: true });

  const pass =
    registry.getError() === undefined && customModel !== undefined && badModel === undefined;

  if (pass) {
    console.log("PASS: invalid plugin catalog shard does not discard valid root models.");
    process.exitCode = 0;
  } else {
    console.error("FAIL: invalid plugin catalog shard caused ModelRegistry to drop valid models.");
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
