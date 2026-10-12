// Model registry tests cover models.json auth modes and SQLite-cached plugin catalogs.
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
import { getApiProvider } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";
import {
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "../plugin-model-catalog.js";
import { AuthStorage } from "./auth-storage.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import { ModelRegistry, type ProviderConfigInput } from "./model-registry.js";
import {
  installModelRegistryTestFixtures,
  pluginOwnerSnapshot,
  pluginOwnerSnapshotEntries,
} from "./model-registry.test-support.js";

const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";

const { writeModelsJson, writeModelsJsonWithPluginCatalog, writeModelsJsonWithPluginCatalogs } =
  installModelRegistryTestFixtures();

function writeGeneratedPluginCatalog(
  providerId: string,
  provider: Record<string, unknown>,
  root: unknown = { providers: {} },
): Promise<string> {
  return writeModelsJsonWithPluginCatalog({
    root,
    pluginRelativePath: join("plugins", providerId, PLUGIN_MODEL_CATALOG_FILE),
    pluginCatalog: {
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: { [providerId]: provider },
    },
  });
}

function oauthProviderConfig(name: string, apiKeyPrefix: string): ProviderConfigInput {
  return {
    oauth: {
      name,
      login: async () => ({
        access: "test-token-placeholder",
        refresh: "test-token-placeholder",
        expires: Date.now() + 60_000,
      }),
      async refreshToken(credentials) {
        return {
          ...credentials,
          access: "test-token-placeholder",
          expires: Date.now() + 60_000,
        };
      },
      getApiKey: (credentials) => `${apiKeyPrefix}:${credentials.access}`,
    },
  };
}

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

  it("forks a catalog with request-isolated auth and provider mutations", async () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          models: [{ id: "example-model" }],
        },
      },
    });
    const template = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const firstAuth = AuthStorage.inMemory();
    const secondAuth = AuthStorage.inMemory();
    const first = template.fork(firstAuth);
    const second = template.fork(secondAuth);

    firstAuth.setRuntimeApiKey("custom", "first-runtime-key");
    secondAuth.setRuntimeApiKey("custom", "second-runtime-key");
    first.registerProvider("first-only", oauthProviderConfig("First only", "first"));

    await expect(first.getApiKeyForProvider("custom")).resolves.toBe("first-runtime-key");
    await expect(second.getApiKeyForProvider("custom")).resolves.toBe("second-runtime-key");
    expect(secondAuth.getOAuthProviders().map((provider) => provider.id)).not.toContain(
      "first-only",
    );
    expect(template.authStorage.getOAuthProviders().map((provider) => provider.id)).not.toContain(
      "first-only",
    );

    const firstModel = first.find("custom", "example-model");
    const secondModel = second.find("custom", "example-model");
    expect(firstModel).toBeDefined();
    expect(secondModel).toBeDefined();
    firstModel!.input.push("image");
    firstModel!.cost.input = 42;
    expect(secondModel!.input).toEqual(["text"]);
    expect(secondModel!.cost.input).toBe(0);
    expect(template.find("custom", "example-model")!.input).toEqual(["text"]);
    expect(template.find("custom", "example-model")!.cost.input).toBe(0);

    first.unregisterProvider("first-only");
    expect(first.find("custom", "example-model")).toBeDefined();
  });

  it("preserves models.json provider auth in a catalog fork", async () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          apiKey: "test-token-placeholder",
          models: [{ id: "example-model" }],
        },
      },
    });
    const template = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    const fork = template.fork(AuthStorage.inMemory());
    const model = fork.find("custom", "example-model");

    expect(model).toBeDefined();
    await expect(fork.getApiKeyForProvider("custom")).resolves.toBe("test-token-placeholder");
    await expect(fork.getApiKeyAndHeaders(model!)).resolves.toEqual({
      ok: true,
      apiKey: "test-token-placeholder",
      headers: undefined,
    });
  });

  it("does not restore a source provider after unregistering it from a fork", () => {
    const template = ModelRegistry.inMemory(AuthStorage.inMemory());
    template.registerProvider("template-only", oauthProviderConfig("Template only", "template"));
    const forkAuth = AuthStorage.inMemory();
    const fork = template.fork(forkAuth);

    expect(forkAuth.getOAuthProviders().map((provider) => provider.id)).toContain("template-only");
    fork.unregisterProvider("template-only");
    expect(forkAuth.getOAuthProviders().map((provider) => provider.id)).not.toContain(
      "template-only",
    );
  });

  it("forks the latest base catalog after the source reloads", () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-responses",
          models: [{ id: "before-reload" }],
        },
      },
    });
    const source = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "https://models.example/v1",
            api: "openai-responses",
            models: [{ id: "after-reload" }],
          },
        },
      }),
      "utf-8",
    );

    source.refresh();
    const fork = source.fork(AuthStorage.inMemory());

    expect(fork.find("custom", "before-reload")).toBeUndefined();
    expect(fork.find("custom", "after-reload")).toBeDefined();
  });

  it.each(["persisted", "registered"] as const)("preserves %s prompt budgets", (source) => {
    // Synthetic providers deliberately share an id but not a prompt budget.
    // Native window and output capacity must remain separate from that budget.
    const providers: Record<string, ProviderConfigInput> = Object.fromEntries(
      (
        [
          ["fixture-primary", 1_000_000, 872_000],
          ["fixture-secondary", 1_050_000, 922_000],
        ] as const
      ).map(([provider, contextWindow, contextTokens]) => [
        provider,
        {
          api: "openai-responses",
          baseUrl: "https://models.example/v1",
          models: [
            {
              id: "shared-model",
              name: "Shared model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow,
              contextTokens,
              maxTokens: 128_000,
            },
          ],
        },
      ]),
    );
    const registry =
      source === "persisted"
        ? ModelRegistry.create(AuthStorage.inMemory(), writeModelsJson({ providers }))
        : ModelRegistry.inMemory(AuthStorage.inMemory());
    if (source === "registered") {
      for (const [provider, config] of Object.entries(providers)) {
        registry.registerProvider(provider, config);
      }
    }
    expect(registry.getError()).toBeUndefined();
    for (const candidate of [registry, registry.fork(AuthStorage.inMemory())]) {
      for (const [provider, config] of Object.entries(providers)) {
        expect(candidate.find(provider, "shared-model")).toMatchObject(config.models![0]!);
      }
    }
  });

  it("keeps estimates out of SQLite catalog metadata and reconstructs them on reload", async () => {
    const provider = "window-fixture";
    const modelsPath = await writeModelsJsonWithPluginCatalog({
      root: { providers: {} },
      pluginRelativePath: "plugins/window-fixture/catalog.json",
      pluginCatalog: {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          [provider]: {
            api: "openai-responses",
            baseUrl: "https://models.example/v1",
            models: [
              { id: "unknown" },
              { id: "prompt-only", contextTokens: 777_000 },
              { id: "reported", contextWindow: 128_000, contextTokens: 777_000 },
              { id: "authored", contextWindow: 64_000 },
            ],
          },
        },
      },
    });
    const pluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(dirname(modelsPath));
    expect(pluginCatalogs).toHaveLength(1);
    const stored = JSON.parse(pluginCatalogs[0]!.contents).providers[provider].models;
    for (const id of ["unknown", "prompt-only"]) {
      expect(stored.find((row: { id: string }) => row.id === id)).not.toHaveProperty(
        "contextWindow",
      );
    }
    expect(pluginCatalogs[0]!.contents).not.toContain("contextWindowSource");
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
      pluginCatalogs,
      pluginMetadataSnapshot: pluginOwnerSnapshot(provider, provider),
    });
    for (const candidate of [registry, registry.fork(AuthStorage.inMemory())]) {
      expect(candidate.find(provider, "unknown")).toMatchObject({
        contextWindow: 128_000,
        contextWindowSource: "synthetic",
      });
      expect(candidate.find(provider, "prompt-only")).toMatchObject({
        contextWindow: 777_000,
        contextTokens: 777_000,
        contextWindowSource: "synthetic",
      });
      for (const [id, window] of [
        ["reported", 128_000],
        ["authored", 64_000],
      ] as const) {
        const runtime = candidate.find(provider, id);
        expect(runtime?.contextWindow).toBe(window);
        expect(runtime).not.toHaveProperty("contextWindowSource");
      }
    }
  });

  it("loads only lifecycle-captured generated catalogs when the root catalog is absent", () => {
    const modelsPath = writeModelsJson({ providers: {} });
    rmSync(modelsPath);
    const capturedCatalog = {
      pluginId: "zai",
      contents: JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            models: [{ id: "glm-5.1", name: "GLM 5.1" }],
          },
        },
      }),
    };

    const pluginMetadataSnapshot = pluginOwnerSnapshotEntries([
      { providerId: "zai", pluginId: "zai" },
      { providerId: "other", pluginId: "other" },
    ]);
    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
      includePluginCatalogs: true,
      modelsJsonContents: null,
      pluginCatalogs: [capturedCatalog],
      pluginMetadataSnapshot,
    });
    const fork = registry.fork(AuthStorage.inMemory());

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
    expect(registry.find("other", "unrelated-model")).toBeUndefined();
    expect(registry.getProviderMetadataOwners()).toBe(pluginMetadataSnapshot.owners);
    expect(fork.getProviderMetadataOwners()).toBe(pluginMetadataSnapshot.owners);
  });

  it("keeps authored provider models available when the plugin catalog database is corrupt", () => {
    const modelsPath = writeModelsJson({
      providers: {
        custom: {
          baseUrl: "https://models.example/v1",
          api: "openai-completions",
          apiKey: "authored-provider-test-key",
          models: [{ id: "authored-model", name: "Authored Model" }],
        },
      },
    });
    writeFileSync(join(dirname(modelsPath), "openclaw-agent.sqlite"), "not a SQLite database");

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);

    expect(registry.find("custom", "authored-model")?.name).toBe("Authored Model");
    expect(registry.getError()).toContain("Failed to load generated plugin model catalogs");
  });

  it("tracks explicit max-token provenance across authored and generated catalogs", async () => {
    const modelsPath = await writeGeneratedPluginCatalog(
      "zai",
      {
        baseUrl: "https://api.z.ai/api/paas/v4",
        api: "openai-completions",
        models: [{ id: "catalog-model", maxTokens: 32_768 }],
      },
      {
        providers: {
          custom: {
            baseUrl: "https://models.example/v1",
            api: "openai-completions",
            models: [{ id: "authored-model", maxTokens: 2_048 }],
          },
        },
      },
    );

    const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
      pluginMetadataSnapshot: pluginOwnerSnapshot("zai", "zai"),
    });

    expect(registry.find("custom", "authored-model")).toMatchObject({
      maxTokens: 2_048,
      maxTokensSource: "configured",
    });
    expect(registry.find("zai", "catalog-model")).toMatchObject({
      maxTokens: 32_768,
      maxTokensSource: "discovered",
    });
  });

  it("preserves response-model compatibility from generated catalogs", async () => {
    const modelsPath = await writeGeneratedPluginCatalog("openai", {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      apiKey: "test-token-placeholder",
      models: [
        {
          id: "gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          compat: { supportsTemperature: false, supportsInstructions: false },
        },
      ],
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ openai: { type: "api_key", key: "test-token-placeholder" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("openai", "openai") },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("openai", "gpt-5.6-luna")?.compat).toMatchObject({
      supportsTemperature: false,
      supportsInstructions: false,
    });
  });

  it("loads richer generated catalog metadata without widening runtime inputs", async () => {
    // Generated catalogs can report video/audio support. Keep those rows while
    // projecting their metadata to the runtime execution contract.
    const modelsPath = await writeModelsJsonWithPluginCatalogs({
      root: { providers: {} },
      pluginCatalogs: [
        {
          pluginRelativePath: join("plugins", "minimax", PLUGIN_MODEL_CATALOG_FILE),
          pluginCatalog: {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              minimax: {
                baseUrl: "https://api.minimaxi.com/v1",
                api: "openai-completions",
                apiKey: "MINIMAX_API_KEY",
                models: [{ id: "MiniMax-M3", input: ["text", "image", "video"] }],
              },
            },
          },
        },
        {
          pluginRelativePath: join("plugins", "nvidia", PLUGIN_MODEL_CATALOG_FILE),
          pluginCatalog: {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              nvidia: {
                baseUrl: "https://integrate.api.nvidia.com/v1",
                api: "openai-completions",
                apiKey: "NVIDIA_API_KEY",
                models: [
                  {
                    id: "microsoft/phi-4-multimodal-instruct",
                    input: ["text", "image", "audio"],
                  },
                  { id: "audio-only", input: ["audio"] },
                  { id: "explicit-empty", input: [] },
                ],
              },
            },
          },
        },
      ],
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({
        minimax: { type: "api_key", key: "sk-minimax" },
        nvidia: { type: "api_key", key: "sk-nvidia" },
      }),
      modelsPath,
      {
        pluginMetadataSnapshot: pluginOwnerSnapshotEntries([
          { providerId: "minimax", pluginId: "minimax" },
          { providerId: "nvidia", pluginId: "nvidia" },
        ]),
      },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("minimax", "MiniMax-M3")?.input).toEqual(["text", "image"]);
    expect(registry.find("nvidia", "microsoft/phi-4-multimodal-instruct")?.input).toEqual([
      "text",
      "image",
    ]);
    expect(registry.find("nvidia", "audio-only")).toBeUndefined();
    expect(registry.find("nvidia", "explicit-empty")?.input).toEqual([]);
    const availableRefs = registry.getAvailable().map((model) => `${model.provider}/${model.id}`);
    expect(availableRefs).not.toContain("nvidia/audio-only");
    expect(availableRefs).toContain("nvidia/explicit-empty");
  });

  it.each(["persisted"] as const)(
    "isolates invalid %s plugin catalogs from valid models",
    async () => {
      const modelsPath = await writeModelsJsonWithPluginCatalogs({
        root: {
          providers: {
            custom: {
              baseUrl: "https://models.example/v1",
              api: "openai-responses",
              apiKey: "CUSTOM_API_KEY",
              models: [{ id: "root-model", name: "Root Model" }],
            },
          },
        },
        pluginCatalogs: [
          {
            pluginRelativePath: join("plugins", "google", PLUGIN_MODEL_CATALOG_FILE),
            pluginCatalog: {
              generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
              providers: {
                "google-vertex": {
                  baseUrl: "https://us-central1-aiplatform.googleapis.com/v1",
                  api: "google-vertex",
                  apiKey: "GOOGLE_API_KEY",
                  models: [
                    {
                      id: "gemini-3.1-pro-preview",
                      name: "Gemini 3.1 Pro",
                      contextWindow: 0,
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

      const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath, {
        pluginMetadataSnapshot: pluginOwnerSnapshotEntries([
          { providerId: "google-vertex", pluginId: "google" },
          { providerId: "zai", pluginId: "zai" },
        ]),
      });

      expect(registry.getError()).toContain(
        "Provider google-vertex, model gemini-3.1-pro-preview: invalid contextWindow",
      );
      expect(registry.find("custom", "root-model")?.name).toBe("Root Model");
      expect(registry.find("zai", "glm-5.1")?.name).toBe("GLM 5.1");
      expect(registry.find("google-vertex", "gemini-3.1-pro-preview")).toBeUndefined();
    },
  );

  it("ignores non-generated SQLite plugin catalog entries", async () => {
    // Plugin catalogs are codegen artifacts; unmarked lookalikes must
    // not extend the provider registry.
    const modelsPath = await writeModelsJsonWithPluginCatalog({
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

  it("ignores generated plugin catalog providers without current ownership", async () => {
    const modelsPath = await writeGeneratedPluginCatalog("zai", {
      baseUrl: "https://api.z.ai/api/paas/v4",
      api: "openai-completions",
      apiKey: "ZAI_API_KEY",
      models: [{ id: "glm-5.1", name: "GLM 5.1" }],
    });

    const registry = ModelRegistry.create(
      AuthStorage.inMemory({ zai: { type: "api_key", key: "sk-test" } }),
      modelsPath,
      { pluginMetadataSnapshot: pluginOwnerSnapshot("other", "other") },
    );

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("zai", "glm-5.1")).toBeUndefined();
  });

  it("ignores generated plugin catalog providers owned by disabled plugins", async () => {
    const modelsPath = await writeGeneratedPluginCatalog("zai", {
      baseUrl: "https://api.z.ai/api/paas/v4",
      api: "openai-completions",
      apiKey: "ZAI_API_KEY",
      models: [{ id: "glm-5.1", name: "GLM 5.1" }],
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

describe("ModelRegistry OAuth provider ownership", () => {
  it("keeps providers isolated when another registry refreshes", async () => {
    const sessionAAuth = AuthStorage.inMemory({
      "corporate-ai": {
        type: "oauth",
        access: "test-token-placeholder",
        refresh: "test-token-placeholder",
        expires: 0,
      },
    });
    const sessionA = ModelRegistry.inMemory(sessionAAuth);
    sessionA.registerProvider("corporate-ai", oauthProviderConfig("Corporate AI", "corporate"));

    const sessionBAuth = AuthStorage.inMemory();
    const sessionB = ModelRegistry.inMemory(sessionBAuth);
    sessionB.registerProvider("team-proxy", oauthProviderConfig("Team Proxy", "team"));

    expect(sessionAAuth.getOAuthProviders().map((provider) => provider.id)).toContain(
      "corporate-ai",
    );
    await expect(sessionA.getApiKeyForProvider("corporate-ai")).resolves.toBe(
      "corporate:test-token-placeholder",
    );

    sessionB.unregisterProvider("team-proxy");

    expect(sessionBAuth.getOAuthProviders().map((provider) => provider.id)).not.toContain(
      "team-proxy",
    );
    expect(sessionAAuth.getOAuthProviders().map((provider) => provider.id)).toContain(
      "corporate-ai",
    );
    await expect(sessionA.getApiKeyForProvider("corporate-ai")).resolves.toBe(
      "corporate:test-token-placeholder",
    );
  });
});

describe("ModelRegistry API provider ownership", () => {
  it("rebuilds built-ins and lifecycle stream registrations on registry refresh", () => {
    const sessionA = ModelRegistry.inMemory(AuthStorage.inMemory());
    const sessionB = ModelRegistry.inMemory(AuthStorage.inMemory());
    const streamA = vi.fn(() => ({}) as never);
    const streamB = vi.fn(() => ({}) as never);

    sessionA.registerProvider("session-a", {
      api: "test-session-api",
      streamSimple: streamA,
    });
    sessionB.registerProvider("session-b", {
      api: "test-session-api",
      streamSimple: streamB,
    });
    const runtimeA = getModelRegistryRuntime(sessionA);
    const runtimeB = getModelRegistryRuntime(sessionB);

    sessionB.refresh();

    expect(runtimeB.apiRegistry.getApiProvider("openai-responses")).toBeDefined();
    expect(runtimeA.apiRegistry.getApiProvider("test-session-api")?.streamSimple).not.toBe(
      runtimeB.apiRegistry.getApiProvider("test-session-api")?.streamSimple,
    );
    expect(getApiProvider("test-session-api")).toBeUndefined();

    sessionB.unregisterProvider("session-b");

    expect(runtimeA.apiRegistry.getApiProvider("test-session-api")).toBeDefined();
    expect(runtimeB.apiRegistry.getApiProvider("test-session-api")).toBeUndefined();
  });
});

describe("ModelRegistry persisted catalog state", () => {
  it.each(["catalog.json.doctor-importing-previous-process"])(
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

  it.each(["disk", "captured"])(
    "limits legacy diagnosis to disk discovery (%s)",
    async (source) => {
      if (process.getuid?.() === 0) {
        return;
      }
      const modelsPath = await writeModelsJsonWithPluginCatalog({
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
    async (source) => {
      const modelsPath = await writeModelsJsonWithPluginCatalogs({
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
