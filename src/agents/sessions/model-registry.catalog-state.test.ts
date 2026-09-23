/** Disk catalog diagnostics and refresh preserve Doctor-owned state. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import {
  installModelRegistryTestFixtures,
  pluginOwnerSnapshot,
  pluginOwnerSnapshotEntries,
} from "./model-registry.test-support.js";

const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";
const { writeModelsJson, writeModelsJsonWithPluginCatalog, writeModelsJsonWithPluginCatalogs } =
  installModelRegistryTestFixtures();

describe("ModelRegistry persisted catalog state", () => {
  it.each(["catalog.json", "catalog.json.doctor-importing-previous-process"])(
    "leaves released provider catalogs for Doctor (%s)",
    async (filename) => {
      // A synthetic provider keeps host credentials out of this migration fixture.
      const providerId = "migrated-catalog-provider";
      const modelsPath = writeModelsJson({ providers: {} });
      const agentDir = dirname(modelsPath);
      const catalogPath = join(agentDir, "plugins", "zai", filename);
      const contents = JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          [providerId]: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            apiKey: "released-zai-provider-test-key",
            models: [{ id: "glm-5.1", name: "GLM 5.1" }],
          },
        },
      });
      mkdirSync(dirname(catalogPath), { recursive: true });
      writeFileSync(catalogPath, contents, "utf8");
      chmodSync(dirname(catalogPath), 0o755);

      const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
        pluginMetadataSnapshot: pluginOwnerSnapshot(providerId, "zai"),
      });

      expect(registry.getError()).toContain("Run openclaw doctor --fix");
      expect(registry.find(providerId, "glm-5.1")).toBeUndefined();
      await expect(registry.getApiKeyForProvider(providerId)).resolves.toBeUndefined();
      expect(registry.getProviderAuthStatus(providerId).configured).toBe(false);
      registry.refresh();
      expect(readFileSync(catalogPath, "utf8")).toBe(contents);
      if (process.platform !== "win32") {
        expect(statSync(dirname(catalogPath)).mode & 0o777).toBe(0o755);
      }
      expect(existsSync(join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
      rmSync(catalogPath);
      registry.getAll();
      registry.getAvailable();
      registry.find(providerId, "glm-5.1");
      expect(registry.getError()).toContain("Run openclaw doctor --fix");
      registry.refresh();
      expect(registry.getError()).toBeUndefined();
    },
  );

  it.each(["disk", "captured", "static"])(
    "limits legacy diagnosis to disk discovery (%s)",
    (source) => {
      if (process.getuid?.() === 0) {
        return;
      }
      const modelsPath = writeModelsJsonWithPluginCatalog({
        root: {
          providers: {
            custom: {
              baseUrl: "https://models.example/v1",
              api: "openai-completions",
              apiKey: "authored-provider-test-key",
              models: [{ id: "authored-model", name: "Authored Model" }],
            },
          },
        },
        pluginRelativePath: join("plugins", "anthropic", PLUGIN_MODEL_CATALOG_FILE),
        pluginCatalog: {
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            anthropic: {
              baseUrl: "https://anthropic.example/v1",
              api: "anthropic-messages",
              apiKey: "healthy-provider-test-key",
              models: [{ id: "healthy-model", name: "Healthy Model" }],
            },
          },
        },
      });
      const sourcePath = join(dirname(modelsPath), "plugins", "zai", PLUGIN_MODEL_CATALOG_FILE);
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(
        sourcePath,
        JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: { zai: { apiKey: "unreadable-released-provider-test-key" } },
        }),
      );
      chmodSync(sourcePath, 0o000);

      try {
        const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
          ...(source === "captured"
            ? {
                modelsJsonContents: readFileSync(modelsPath, "utf8"),
                pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath)),
              }
            : {}),
          ...(source === "static" ? { staticProviderConfigs: {} } : {}),
          pluginMetadataSnapshot: pluginOwnerSnapshotEntries([
            { providerId: "anthropic", pluginId: "anthropic" },
            { providerId: "zai", pluginId: "zai" },
          ]),
        });

        if (source === "disk") {
          expect(registry.getError()).toContain("Could not read legacy provider catalog");
          expect(registry.getError()).toContain("Run openclaw doctor --fix");
        } else {
          expect(registry.getError()).toBeUndefined();
        }
        expect(registry.find("custom", "authored-model")?.name).toBe("Authored Model");
        expect(registry.find("anthropic", "healthy-model")?.name).toBe("Healthy Model");
        expect(existsSync(sourcePath)).toBe(true);
      } finally {
        chmodSync(sourcePath, 0o600);
      }
    },
  );

  it.each(["generated", "persisted"])(
    "keeps %s catalog state unchanged across registry refresh",
    (source) => {
      const modelsPath = writeModelsJsonWithPluginCatalogs({
        root: { providers: {} },
        pluginCatalogs: [
          {
            pluginRelativePath: join("plugins", "nvidia", PLUGIN_MODEL_CATALOG_FILE),
            pluginCatalog: {
              generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
              providers: {
                nvidia: {
                  baseUrl: "https://integrate.api.nvidia.com/v1",
                  apiKey: "NVIDIA_API_KEY",
                  models: [
                    {
                      id: "meta-llama/llama-3.3-70b-instruct",
                      name: "Llama 3.3 70B Instruct",
                    },
                  ],
                },
              },
            },
          },
          {
            pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
            pluginCatalog: {
              generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
              providers: {
                zai: {
                  baseUrl: "https://api.z.ai/api/paas/v4",
                  api: "openai-completions",
                  apiKey: "ZAI_API_KEY",
                  models: [{ id: "glm-5.1", name: "GLM 5.1" }],
                },
              },
            },
          },
        ],
      });
      const snapshot = pluginOwnerSnapshotEntries([
        { providerId: "nvidia", pluginId: "nvidia" },
        { providerId: "zai", pluginId: "zai" },
      ]);
      if (source === "persisted") {
        const database = new DatabaseSync(join(dirname(modelsPath), "openclaw-agent.sqlite"));
        try {
          database
            .prepare(
              "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
            )
            .run(
              JSON.stringify({
                generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
                providers: {
                  nvidia: {
                    baseUrl: "https://integrate.api.nvidia.com/v1",
                    apiKey: "NVIDIA_API_KEY",
                    models: [{ id: "missing-api" }],
                  },
                },
              }),
              "plugin-model-catalog-v1",
              "nvidia",
            );
        } finally {
          database.close();
        }
      }
      const before = loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath));

      const errors = Array.from({ length: 3 }, () => {
        const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
          pluginMetadataSnapshot: snapshot,
        });
        registry.refresh();
        expect(registry.find("nvidia", "meta-llama/llama-3.3-70b-instruct")).toBeUndefined();
        expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
        return registry.getError();
      });

      expect(errors).toEqual(
        Array(3).fill(
          source === "persisted"
            ? expect.stringContaining('Provider nvidia, model missing-api: no "api" specified')
            : undefined,
        ),
      );
      expect(loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath))).toEqual(before);
    },
  );
});
