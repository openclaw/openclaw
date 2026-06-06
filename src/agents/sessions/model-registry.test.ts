// Model registry tests cover models.json auth modes and plugin-owned model
// catalog shards.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_MODEL_CATALOG_FILE,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

const tempDirs: string[] = [];

function writeModelsJson(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-model-registry-"));
  tempDirs.push(dir);
  const file = join(dir, "models.json");
  writeFileSync(file, JSON.stringify(contents, null, 2), "utf-8");
  return file;
}

function writeModelsJsonWithPluginCatalog(params: {
  root: unknown;
  pluginRelativePath: string;
  pluginCatalog: unknown;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-model-registry-"));
  tempDirs.push(dir);
  const file = join(dir, "models.json");
  const pluginFile = join(dir, params.pluginRelativePath);
  mkdirSync(dirname(pluginFile), { recursive: true });
  writeFileSync(file, JSON.stringify(params.root, null, 2), "utf-8");
  writeFileSync(pluginFile, JSON.stringify(params.pluginCatalog, null, 2), "utf-8");
  return file;
}

function pluginOwnerSnapshot(providerId: string, pluginId: string, enabled = true) {
  // The registry only trusts generated provider shards that are still owned by
  // an enabled plugin in the current metadata snapshot.
  return {
    index: {
      plugins: [{ pluginId, enabled }],
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ModelRegistry models.json auth", () => {
  it("accepts Bedrock AWS SDK auth without apiKey", async () => {
    // AWS SDK credential resolution is provider-owned; requiring an apiKey here
    // would make Bedrock catalogs impossible to express in models.json.
    const modelsPath = writeModelsJson({
      providers: {
        "amazon-bedrock": {
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          api: "bedrock-converse-stream",
          auth: "aws-sdk",
          models: [
            {
              id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
              name: "Claude Sonnet 4.5",
            },
          ],
        },
      },
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const model = registry.find("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0");

    expect(registry.getError()).toBeUndefined();
    expect(model).toBeDefined();
    expect(registry.getAvailable()).toEqual([model]);
    await expect(registry.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: undefined,
      headers: undefined,
    });
    expect(registry.getProviderAuthStatus("amazon-bedrock")).toEqual({
      configured: true,
      source: "models_json_key",
      label: "aws-sdk",
    });
  });

  it("still rejects api-key custom models without apiKey", () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          models: [{ id: "example-model" }],
        },
      },
    });

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);

    expect(registry.getError()).toContain('Provider custom: "apiKey" is required');
    expect(registry.find("custom", "example-model")).toBeUndefined();
  });

  it("loads provider models from generated plugin catalog shards", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
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
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("zai", "zai") },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
  });

  it("ignores non-generated plugin catalog files", () => {
    // Plugin catalog shards are codegen artifacts; hand-written lookalikes must
    // not extend the provider registry.
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "zai", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            apiKey: "ZAI_API_KEY",
            models: [{ id: "glm-5.1", name: "GLM 5.1" }],
          },
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });

  it("ignores generated plugin catalog providers without current ownership", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
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
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("other", "other") },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });

  it("ignores generated plugin catalog providers owned by disabled plugins", () => {
    const modelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
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
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("zai", "zai", false) },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });
});

describe("ModelRegistry default-agent catalog inheritance", () => {
  // Model discovery only runs for the default agent at gateway startup, so a freshly
  // created secondary agent has an apiKey-only google catalog with no models. Without
  // read-through inheritance it fails at runtime with "Unknown model: google/...".
  function writeGoogleCatalogAgentDir(params: { withModels: boolean; modelName?: string }): string {
    return writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "google", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          google: params.withModels
            ? {
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                api: "openai-responses",
                apiKey: "GEMINI_API_KEY",
                models: [
                  { id: "gemini-2.5-flash", name: params.modelName ?? "Gemini 2.5 Flash" },
                ],
              }
            : { apiKey: "GEMINI_API_KEY" },
        },
      },
    });
  }

  it("inherits the default agent's generated catalog models for a secondary agent", () => {
    const defaultAgentDir = dirname(writeGoogleCatalogAgentDir({ withModels: true }));
    const secondaryModelsPath = writeGoogleCatalogAgentDir({ withModels: false });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ google: { type: "api_key", key: "sk-test" } }),
      secondaryModelsPath,
      {
        pluginMetadataSnapshot: pluginOwnerSnapshot("google", "google"),
        inheritedAgentDir: defaultAgentDir,
      },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("google", "gemini-2.5-flash")?.name).toBe("Gemini 2.5 Flash");
  });

  it("does not inherit without an inheritedAgentDir (reproduces the bug)", () => {
    const secondaryModelsPath = writeGoogleCatalogAgentDir({ withModels: false });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ google: { type: "api_key", key: "sk-test" } }),
      secondaryModelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("google", "google") },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("google", "gemini-2.5-flash")).toBeUndefined();
  });

  it("prefers the secondary agent's own catalog over inherited models", () => {
    const defaultAgentDir = dirname(
      writeGoogleCatalogAgentDir({ withModels: true, modelName: "Gemini 2.5 Flash (default)" }),
    );
    const secondaryModelsPath = writeGoogleCatalogAgentDir({
      withModels: true,
      modelName: "Gemini 2.5 Flash (local)",
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ google: { type: "api_key", key: "sk-test" } }),
      secondaryModelsPath,
      {
        pluginMetadataSnapshot: pluginOwnerSnapshot("google", "google"),
        inheritedAgentDir: defaultAgentDir,
      },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("google", "gemini-2.5-flash")?.name).toBe("Gemini 2.5 Flash (local)");
  });

  it("does not let an inherited catalog override a local provider's config/headers or leak sibling models", async () => {
    // Regression: a provider the secondary agent defines in its own models.json must keep
    // its local request config (headers/auth) and must NOT gain sibling models from the
    // default agent's catalog — otherwise a local model would run with the default agent's
    // credentials/transport (a cross-agent boundary violation), and inheritance would no
    // longer be "local always wins".
    const defaultAgentDir = dirname(
      writeModelsJsonWithPluginCatalog({
        root: { providers: {} },
        pluginRelativePath: join("plugins", "google", PLUGIN_MODEL_CATALOG_FILE),
        pluginCatalog: {
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            google: {
              baseUrl: "https://default.example/v1beta",
              api: "openai-responses",
              apiKey: "GEMINI_API_KEY",
              headers: { "x-source": "default" },
              models: [
                { id: "gemini-2.5-flash", name: "Flash (default)" },
                { id: "gemini-3-flash-preview", name: "3 Flash (default)" },
              ],
            },
          },
        },
      }),
    );

    // Secondary agent owns google via its OWN models.json (not a plugin catalog).
    const secondaryModelsPath = writeModelsJson({
      providers: {
        google: {
          baseUrl: "https://local.example/v1beta",
          api: "openai-responses",
          apiKey: "GEMINI_API_KEY",
          headers: { "x-source": "local" },
          models: [{ id: "gemini-2.5-flash", name: "Flash (local)" }],
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ google: { type: "api_key", key: "sk-test" } }),
      secondaryModelsPath,
      {
        pluginMetadataSnapshot: pluginOwnerSnapshot("google", "google"),
        inheritedAgentDir: defaultAgentDir,
      },
    );

    expect(registry.getError()).toBeUndefined();

    const local = registry.find("google", "gemini-2.5-flash");
    expect(local?.name).toBe("Flash (local)");
    // Per-provider gating: the default agent's sibling model must not leak in.
    expect(registry.find("google", "gemini-3-flash-preview")).toBeUndefined();

    // Local provider request config (headers) must survive inherited loading.
    const resolved = await registry.getApiKeyAndHeaders(local!);
    if (!resolved.ok) {
      throw new Error(`expected resolved auth, got error: ${resolved.error}`);
    }
    expect(resolved.headers?.["x-source"]).toBe("local");
  });

  it("resolves local request config when the local provider comes from a local plugin catalog", async () => {
    // Same guarantee as above, but the local provider is owned via a local plugin catalog
    // (not root models.json) — covers the other registration path end-to-end.
    const defaultAgentDir = dirname(
      writeModelsJsonWithPluginCatalog({
        root: { providers: {} },
        pluginRelativePath: join("plugins", "google", PLUGIN_MODEL_CATALOG_FILE),
        pluginCatalog: {
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            google: {
              baseUrl: "https://default.example/v1beta",
              api: "openai-responses",
              apiKey: "GEMINI_API_KEY",
              headers: { "x-source": "default" },
              models: [
                { id: "gemini-2.5-flash", name: "Flash (default)" },
                { id: "gemini-3-flash-preview", name: "3 Flash (default)" },
              ],
            },
          },
        },
      }),
    );

    const secondaryModelsPath = writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: join("plugins", "google", PLUGIN_MODEL_CATALOG_FILE),
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          google: {
            baseUrl: "https://local.example/v1beta",
            api: "openai-responses",
            apiKey: "GEMINI_API_KEY",
            headers: { "x-source": "local" },
            models: [{ id: "gemini-2.5-flash", name: "Flash (local)" }],
          },
        },
      },
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ google: { type: "api_key", key: "sk-test" } }),
      secondaryModelsPath,
      {
        pluginMetadataSnapshot: pluginOwnerSnapshot("google", "google"),
        inheritedAgentDir: defaultAgentDir,
      },
    );

    expect(registry.getError()).toBeUndefined();

    const local = registry.find("google", "gemini-2.5-flash");
    expect(local?.name).toBe("Flash (local)");
    expect(registry.find("google", "gemini-3-flash-preview")).toBeUndefined();

    const resolved = await registry.getApiKeyAndHeaders(local!);
    if (!resolved.ok) {
      throw new Error(`expected resolved auth, got error: ${resolved.error}`);
    }
    expect(resolved.headers?.["x-source"]).toBe("local");
  });

  it("resolves an inherited-only provider with the inherited baseUrl and headers", async () => {
    // For a provider the secondary agent does not configure at all, inheritance must supply
    // the default agent's baseUrl/api and request headers so the model is actually usable.
    const defaultAgentDir = dirname(
      writeModelsJsonWithPluginCatalog({
        root: { providers: {} },
        pluginRelativePath: join("plugins", "google", PLUGIN_MODEL_CATALOG_FILE),
        pluginCatalog: {
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {
            google: {
              baseUrl: "https://inherited.example/v1beta",
              api: "openai-responses",
              apiKey: "GEMINI_API_KEY",
              headers: { "x-source": "inherited" },
              models: [{ id: "gemini-2.5-flash", name: "Flash (inherited)" }],
            },
          },
        },
      }),
    );

    // Secondary agent configures no provider of its own (lives on inheritance).
    const secondaryModelsPath = writeModelsJson({ providers: {} });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ google: { type: "api_key", key: "sk-test" } }),
      secondaryModelsPath,
      {
        pluginMetadataSnapshot: pluginOwnerSnapshot("google", "google"),
        inheritedAgentDir: defaultAgentDir,
      },
    );

    expect(registry.getError()).toBeUndefined();

    const model = registry.find("google", "gemini-2.5-flash");
    expect(model?.baseUrl).toBe("https://inherited.example/v1beta");

    const resolved = await registry.getApiKeyAndHeaders(model!);
    if (!resolved.ok) {
      throw new Error(`expected resolved auth, got error: ${resolved.error}`);
    }
    expect(resolved.headers?.["x-source"]).toBe("inherited");
  });
});
