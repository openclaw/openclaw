import { setImmediate as nextTurn } from "node:timers/promises";
import { createApiRegistry } from "@openclaw/ai";
import { beforeEach, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";

const mocks = vi.hoisted(() => ({
  acquireRuntimeLease: vi.fn(),
  disposeRuntime: vi.fn(async () => {}),
  getApiKeyForModel: vi.fn(),
  prepareProviderRuntimeAuth: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
  publishedGeneration: "A",
  readGeneration: (() => "unscoped") as () => string,
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: mocks.acquireRuntimeLease,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

vi.mock("../plugins/runtime/generation-scope.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const generation = new AsyncLocalStorage<string>();
  mocks.readGeneration = () => generation.getStore() ?? mocks.publishedGeneration;
  return {
    getPluginRuntimeGenerationRegistry: () => undefined,
    withPluginRuntimeGenerationScope: (snapshot: { testGeneration?: string }, run: () => unknown) =>
      generation.run(snapshot.testGeneration ?? "unknown", run),
  };
});

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: Model) => model,
  applyLocalNoAuthHeaderOverride: (model: Model) => model,
  formatMissingAuthError: vi.fn(),
  getApiKeyForModelCore: mocks.getApiKeyForModel,
  resolveApiKeyForProviderCore: mocks.getApiKeyForModel,
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  prepareProviderRuntimeAuth: mocks.prepareProviderRuntimeAuth,
}));

vi.mock("./sessions/model-registry-runtime.js", () => ({
  initializeModelRegistryRuntime: vi.fn(),
  getModelRegistryRuntime: () => {
    const apiRegistry = createApiRegistry();
    return { apiRegistry, llmRuntime: { registry: apiRegistry, streamSimple: vi.fn() } };
  },
}));

import {
  prepareSimpleCompletionModel,
  acquireSimpleCompletionModel,
  acquireSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

function createOllamaModelResolver(): SimpleCompletionModelResolver {
  return vi.fn(async (provider, modelId, _agentDir, _cfg, options) => ({
    model: {
      provider,
      id: modelId,
      name: modelId,
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    } satisfies Model,
    authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
    modelRegistry: options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
  }));
}

let preparedModelRuntime: PreparedModelRuntimeSnapshot & { testGeneration: string };

beforeEach(() => {
  mocks.publishedGeneration = "A";
  mocks.acquireRuntimeLease.mockReset();
  mocks.disposeRuntime.mockReset();
  mocks.getApiKeyForModel.mockReset();
  mocks.prepareProviderRuntimeAuth.mockReset();
  mocks.resolvePluginMetadataSnapshot
    .mockReset()
    .mockReturnValue(createPluginMetadataSnapshotFixture());
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  preparedModelRuntime = {
    testGeneration: "A",
    catalogOwner: undefined,
    observationConfig: {},
    isCurrent: () => true,
    agentDir: "/tmp/openclaw-agent",
    workspaceDir: "/tmp/runtime-workspace",
    config: {},
    authModes: {},
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [], routeVariants: [] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    activeProjectKeys: [],
    createStores: () => ({ authStorage, modelRegistry }),
  };
  mocks.acquireRuntimeLease.mockResolvedValue({
    snapshot: preparedModelRuntime,
    [Symbol.asyncDispose]: mocks.disposeRuntime,
  });
});

it("keeps route rematerialization and runtime auth on the supplied generation", async () => {
  const observedModelGenerations: string[] = [];
  const observedRuntimeAuthGenerations: string[] = [];
  const modelResolver: SimpleCompletionModelResolver = vi.fn(
    async (provider, modelId, _agentDir, cfg, options) => {
      if (!options?.authStorage || !options.modelRegistry) {
        throw new Error("prepared stores were not bound");
      }
      const generation = mocks.readGeneration();
      observedModelGenerations.push(generation);
      mocks.publishedGeneration = "B";
      await Promise.resolve();
      const configured = cfg?.models?.providers?.openai;
      return {
        model: {
          provider,
          id: modelId,
          name: modelId,
          api: configured?.api ?? "openai-chatgpt-responses",
          baseUrl: configured?.baseUrl ?? "https://chatgpt.com/backend-api/codex",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4096,
          params: { generation },
        } satisfies Model,
        authStorage: options.authStorage,
        modelRegistry: options.modelRegistry,
      };
    },
  );
  mocks.getApiKeyForModel.mockImplementation(async () => {
    await Promise.resolve();
    mocks.publishedGeneration = "B";
    return {
      apiKey: "sk-platform",
      source: "models.providers.openai",
      mode: "api-key",
    };
  });
  mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
    observedRuntimeAuthGenerations.push(mocks.readGeneration());
    return undefined;
  });

  const result = await prepareSimpleCompletionModel({
    preparedModelRuntime,
    cfg: {
      models: {
        providers: { openai: { baseUrl: "", models: [], apiKey: "fixture-api-key" } },
      },
    },
    agentId: "main",
    provider: "openai",
    modelId: "gpt-5.5",
    agentDir: "/tmp/openclaw-agent",
    modelResolver,
  });

  expect(result).not.toHaveProperty("error");
  if ("error" in result) {
    throw new Error(result.error);
  }
  const prepared = result;
  expect(prepared.model.params).toMatchObject({ generation: "A" });
  expect(observedModelGenerations).toEqual(["A", "A"]);
  expect(observedRuntimeAuthGenerations).toEqual(["A"]);
});

it.each([false, true])(
  "disposes uncooperative preparation after cancellation (cleanup failure: %s)",
  async (cleanupFails) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    const cancelled = new Error("completion preparation cancelled");
    const cleanupError = new Error("completion preparation cleanup failed");
    const parent = new AsyncWorkScope();
    const cleanupEntered = createDeferredCore();
    const releaseCleanup = createDeferredCore();
    const dispose = mocks.disposeRuntime.mockImplementation(async () => {
      cleanupEntered.resolve();
      await releaseCleanup.promise;
      if (cleanupFails) {
        throw cleanupError;
      }
    });
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "local-fixture",
      source: "local marker",
      mode: "api-key",
    });
    const resolve = createOllamaModelResolver();
    const preparing = parent.run(() =>
      acquireSimpleCompletionModel({
        cfg: {},
        agentId: "main",
        provider: "ollama",
        modelId: "fixture-model",
        signal: controller.signal,
        modelResolver: async (...args) => {
          entered.resolve();
          await release.promise;
          return await resolve(...args);
        },
      }),
    );
    try {
      await entered.promise;
      controller.abort(cancelled);
      release.resolve();
      await expect(preparing).rejects.toBe(cancelled);
      let parentClosed = false;
      const draining = parent.drain().then(() => {
        parentClosed = true;
      });
      await cleanupEntered.promise;
      await nextTurn();
      expect(parentClosed).toBe(false);
      releaseCleanup.resolve();
      await draining;
      expect(dispose).toHaveBeenCalledOnce();
      const cleanup = dispose.mock.results[0]!.value;
      if (cleanupFails) {
        await expect(cleanup).rejects.toBe(cleanupError);
      } else {
        await expect(cleanup).resolves.toBeUndefined();
      }
    } finally {
      release.resolve();
      releaseCleanup.resolve();
      await Promise.allSettled([preparing, parent.drain()]);
    }
  },
);

it("acquires direct completion runtime for the exact selected model", async () => {
  const modelResolver = createOllamaModelResolver();
  mocks.getApiKeyForModel.mockResolvedValue({
    apiKey: "ollama-local",
    source: "local marker",
    mode: "api-key",
  });

  const acquired = await acquireSimpleCompletionModel({
    cfg: {},
    agentId: "main",
    provider: "ollama",
    modelId: "qwen3:0.6b",
    agentDir: "/tmp/openclaw-agent",
    agentRuntimeId: "openclaw",
    modelResolver,
  });

  if ("error" in acquired) {
    throw new Error(acquired.error);
  }
  try {
    expect(mocks.acquireRuntimeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [
          {
            provider: "ollama",
            modelId: "qwen3:0.6b",
            runtime: "openclaw",
            agentId: "main",
          },
        ],
      }),
      expect.objectContaining({ catalogMode: "static" }),
    );
    expect(modelResolver).toHaveBeenCalledOnce();
  } finally {
    await acquired[Symbol.asyncDispose]();
  }
});

it("selects an explicit agent completion model before runtime acquisition", async () => {
  const modelResolver = createOllamaModelResolver();
  mocks.getApiKeyForModel.mockResolvedValue({
    apiKey: "ollama-local",
    source: "local marker",
    mode: "api-key",
  });

  const result = await acquireSimpleCompletionModelForAgent({
    cfg: {},
    agentId: "main",
    modelRef: "ollama/qwen3:0.6b",
    modelResolver,
  });

  try {
    expect(mocks.acquireRuntimeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [{ provider: "ollama", modelId: "qwen3:0.6b", agentId: "main" }],
      }),
      expect.objectContaining({ catalogMode: "static" }),
    );
    expect(modelResolver).toHaveBeenCalledOnce();
  } finally {
    if (!("error" in result)) {
      await result[Symbol.asyncDispose]();
    }
  }
});

it("acquires the canonical manifest-derived utility model selection", async () => {
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "selected-provider",
        modelCatalog: {
          providers: {
            "selected-provider": {
              defaultUtilityModel: "utility-model",
              models: [{ id: "primary-model" }, { id: "utility-model" }],
            },
          },
        },
      },
    ],
  });
  mocks.resolvePluginMetadataSnapshot.mockReturnValue(metadataSnapshot);

  const result = await acquireSimpleCompletionModelForAgent({
    cfg: {
      agents: { defaults: { model: "selected-provider/primary-model@work" } },
    },
    agentId: "main",
    agentDir: "/tmp/canonical-agent",
    useUtilityModel: true,
    modelResolver: vi.fn(async (_provider, _modelId, _agentDir, _cfg, options) => ({
      error: "stop after canonical selection",
      authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
      modelRegistry: options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
    })),
  });

  try {
    expect(
      mocks.resolvePluginMetadataSnapshot.mock.calls.filter(
        ([params]) => (params as { pluginIdScope?: unknown } | undefined)?.pluginIdScope,
      ),
    ).toHaveLength(2);
    expect(mocks.acquireRuntimeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: [
          { provider: "selected-provider", modelId: "utility-model", agentId: "main" },
        ],
        agentDir: "/tmp/canonical-agent",
      }),
      expect.objectContaining({ catalogMode: "static", pluginMetadataSnapshot: metadataSnapshot }),
    );
    expect(result).toMatchObject({
      selection: {
        provider: "selected-provider",
        modelId: "utility-model",
        profileId: "work",
        agentDir: "/tmp/canonical-agent",
      },
    });
  } finally {
    if (!("error" in result)) {
      await result[Symbol.asyncDispose]();
    }
  }
});

it.each(["/", "entry"])(
  "materializes a bare default once through actual agent acquisition (override=%s)",
  async (modelRef) => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "default-normalizer",
          modelIdNormalization: {
            providers: { openai: { aliases: { entry: "middle", middle: "final" } } },
          },
        },
      ],
    });
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(metadataSnapshot);
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "ollama-local",
      source: "local marker",
      mode: "api-key",
    });
    const release = vi.fn(async () => {});
    mocks.acquireRuntimeLease.mockResolvedValue({
      snapshot: preparedModelRuntime,
      [Symbol.asyncDispose]: release,
    });
    const resolveModel = createOllamaModelResolver();
    const modelResolver: SimpleCompletionModelResolver = async (...args) => {
      const resolved = await resolveModel(...args);
      return args[1] === "middle"
        ? resolved
        : { ...resolved, model: undefined, error: `Unexpected selected model: ${args[1]}` };
    };
    const result = await acquireSimpleCompletionModelForAgent({
      cfg: { agents: { entries: { main: {} }, defaults: { model: "entry" } } },
      agentId: "main",
      modelRef,
      modelResolver,
    });

    try {
      expect(result).toMatchObject({
        selection: { provider: "openai", modelId: "middle" },
        model: { provider: "openai", id: "middle", contextWindow: 8192 },
      });
      expect(mocks.acquireRuntimeLease).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePluginSelections: [{ provider: "openai", modelId: "middle", agentId: "main" }],
        }),
        expect.objectContaining({
          catalogMode: "static",
          pluginMetadataSnapshot: metadataSnapshot,
        }),
      );
    } finally {
      if (!("error" in result)) {
        await result[Symbol.asyncDispose]();
      }
    }
    expect(release).toHaveBeenCalledOnce();
  },
);
