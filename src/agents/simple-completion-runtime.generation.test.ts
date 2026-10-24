import { setImmediate as nextTurn } from "node:timers/promises";
import { createApiRegistry } from "@openclaw/ai";
import { beforeEach, expect, it, vi } from "vitest";
import type { Model } from "../llm/types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveSecretSentinel } from "../secrets/sentinel.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createEmptyPreparedModelRuntimeFixture } from "./embedded-agent-runner/model.fixture.test-support.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";
import {
  assertPrepared,
  completionConfig,
  completionModel,
} from "./simple-completion.test-support.js";

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

// mock-isolation: generation ownership uses an empty auth store without host credential discovery.
vi.mock("./auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStoreAsync: async () => ({ version: 1, profiles: {} }),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

// mock-isolation: a private generation store records which generation each step reads.
vi.mock("../plugins/runtime/generation-scope.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const generation = new AsyncLocalStorage<string>();
  mocks.readGeneration = () => generation.getStore() ?? mocks.publishedGeneration;
  return {
    getPluginRuntimeGenerationRegistry: () => undefined,
    runOutsidePluginRuntimeGenerationScope: (run: () => unknown) => generation.exit(run),
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
  acquireSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

function createOllamaModelResolver(): SimpleCompletionModelResolver {
  return vi.fn(async (provider, modelId, _agentDir, _cfg, options) => ({
    model: completionModel({ provider, id: modelId }),
    authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
    modelRegistry: options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
  }));
}

let preparedModelRuntime: PreparedModelRuntimeSnapshot & { testGeneration: string };

beforeEach(() => {
  mocks.publishedGeneration = "A";
  mocks.acquireRuntimeLease.mockReset();
  mocks.disposeRuntime.mockReset();
  mocks.getApiKeyForModel.mockReset().mockResolvedValue({
    apiKey: "ollama-local",
    source: "local marker",
    mode: "api-key",
  });
  mocks.prepareProviderRuntimeAuth.mockReset();
  mocks.resolvePluginMetadataSnapshot
    .mockReset()
    .mockReturnValue(createPluginMetadataSnapshotFixture());
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  preparedModelRuntime = {
    ...createEmptyPreparedModelRuntimeFixture({
      agentDir: "/tmp/openclaw-agent",
      config: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      createStores: () => ({ authStorage, modelRegistry }),
    }),
    testGeneration: "A",
    workspaceDir: "/tmp/runtime-workspace",
  };
  mocks.acquireRuntimeLease.mockResolvedValue({
    snapshot: preparedModelRuntime,
    [Symbol.asyncDispose]: mocks.disposeRuntime,
  });
});

it("keeps route rematerialization and runtime auth on the supplied generation", async () => {
  const observedModelGenerations: string[] = [];
  const observedRuntimeAuthGenerations: string[] = [];
  const modelResolver: SimpleCompletionModelResolver = async (
    provider,
    modelId,
    _agentDir,
    cfg,
    options,
  ) => {
    if (!options?.authStorage || !options.modelRegistry) {
      throw new Error("prepared stores were not bound");
    }
    const generation = mocks.readGeneration();
    observedModelGenerations.push(generation);
    mocks.publishedGeneration = "B";
    await Promise.resolve();
    const configured = cfg?.models?.providers?.openai;
    return {
      model: completionModel({
        provider,
        id: modelId,
        api: configured?.api ?? "openai-chatgpt-responses",
        baseUrl: configured?.baseUrl ?? "https://chatgpt.com/backend-api/codex",
        reasoning: true,
        params: { generation },
      }),
      authStorage: options.authStorage,
      modelRegistry: options.modelRegistry,
    };
  };
  mocks.getApiKeyForModel.mockImplementation(async () => {
    await Promise.resolve();
    mocks.publishedGeneration = "B";
    return { apiKey: "sk-platform", source: "models.providers.openai", mode: "api-key" };
  });
  mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
    observedRuntimeAuthGenerations.push(mocks.readGeneration());
    return undefined;
  });

  const result = await prepareSimpleCompletionModel({
    preparedModelRuntime,
    cfg: completionConfig("openai", { baseUrl: "", models: [], apiKey: "fixture-api-key" }),
    agentId: "main",
    provider: "openai",
    modelId: "gpt-5.5",
    agentDir: "/tmp/openclaw-agent",
    modelResolver,
  });

  assertPrepared(result);
  expect(result.model.params).toMatchObject({ generation: "A" });
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
    const resolve = createOllamaModelResolver();
    const preparing = parent.run(() =>
      acquireSimpleCompletionModelForAgent({
        cfg: {},
        agentId: "main",
        modelRef: "ollama/fixture-model",
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
      const cleanup = expect(dispose.mock.results[0]!.value);
      await (cleanupFails ? cleanup.rejects : cleanup.resolves).toBe(
        cleanupFails ? cleanupError : undefined,
      );
    } finally {
      release.resolve();
      releaseCleanup.resolve();
      await Promise.allSettled([preparing, parent.drain()]);
    }
  },
);

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

    assertPrepared(result);
    {
      await using prepared = result;
      expect(prepared).toMatchObject({
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
    }
    expect(mocks.disposeRuntime).toHaveBeenCalledOnce();
  },
);

it.each(["current", "credential lookup", "provider auth exchange"] as const)(
  "keeps required-worker authority live through %s",
  async (revokedDuring) => {
    const setRuntimeApiKey = vi.spyOn(
      preparedModelRuntime.createStores().authStorage,
      "setRuntimeApiKey",
    );
    let current = true;
    const revoked = new Error("worker claim revoked");
    const required = { cloudWorkers: { requiredProfile: "required" } };
    preparedModelRuntime = { ...preparedModelRuntime, config: required };
    mocks.getApiKeyForModel.mockImplementation(async () => {
      await Promise.resolve();
      if (revokedDuring === "credential lookup") {
        current = false;
      }
      return { apiKey: "worker-source-token", source: "worker fixture", mode: "token" };
    });
    mocks.prepareProviderRuntimeAuth.mockImplementation(async () => {
      await Promise.resolve();
      if (revokedDuring === "provider auth exchange") {
        current = false;
      }
      return { apiKey: "worker-runtime-token" };
    });
    const preparing = prepareSimpleCompletionModel({
      preparedModelRuntime,
      cfg: required,
      provider: "ollama",
      modelId: "fixture-model",
      modelResolver: createOllamaModelResolver(),
      workerInferenceAuthority: {
        assertCurrent: () => {
          if (!current) {
            throw revoked;
          }
        },
      },
    });
    if (revokedDuring === "current") {
      expect(await preparing).not.toHaveProperty("error");
      const [provider, credential] = setRuntimeApiKey.mock.calls[0] as [string, string];
      expect(provider).toBe("ollama");
      expect(resolveSecretSentinel(credential)).toBe("worker-runtime-token");
    } else {
      await expect(preparing).rejects.toBe(revoked);
    }
    expect(mocks.prepareProviderRuntimeAuth).toHaveBeenCalledTimes(
      revokedDuring === "credential lookup" ? 0 : 1,
    );
    expect(setRuntimeApiKey).toHaveBeenCalledTimes(revokedDuring === "current" ? 1 : 0);
  },
);
