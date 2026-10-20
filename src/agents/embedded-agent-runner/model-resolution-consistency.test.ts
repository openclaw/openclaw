import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareModelRunCapabilities,
  resolvePreparedModelThinkingCompat as thinkingCompatForModel,
} from "../model-catalog-lookup.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { resolveModelCandidateChain as modelChain } from "../model-fallback-candidates.js";
import { resolveInitialEmbeddedRunModel as initialModel } from "./run/runtime-resolution.js";

const STATIC_MODEL_ID = "claude-haiku-4-5";
const PROVIDER = "anthropic";
const selectModelHook = vi.hoisted(() =>
  vi.fn(async ({ provider, modelId }: { provider: string; modelId: string }) => ({
    provider,
    modelId,
  })),
);
const loadManifest = vi.hoisted(() => vi.fn());
const normalizeModel = vi.hoisted(() => vi.fn(() => undefined));
const resolveThinking = vi.hoisted(() => vi.fn(() => "off"));
const warn = vi.hoisted(() => vi.fn());

const modelRegistry = {
  find: vi.fn((_provider: string, _modelId: string) => null),
};
const authStorage = {
  setRuntimeApiKey: vi.fn(),
};
const catalogModel = {
  provider: PROVIDER,
  id: STATIC_MODEL_ID,
  name: "Claude Haiku 4.5",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 64_000,
  compat: { supportsLongCacheRetention: false },
  compactionThinkingDefault: "off",
};

const resolveModelAsyncMock = vi.fn(
  async (
    provider: string,
    modelId: string,
    _agentDir?: string,
    _config?: unknown,
    options?: {
      allowBundledStaticCatalogFallback?: boolean;
      authStorage?: unknown;
      modelRegistry?: unknown;
    },
  ) => {
    const stores = {
      authStorage: options?.authStorage ?? authStorage,
      modelRegistry: options?.modelRegistry ?? modelRegistry,
    };
    if (modelId === "missing-compaction-model") {
      return { ...stores, error: "Provider-specific model resolution failed" };
    }
    if (options?.allowBundledStaticCatalogFallback) {
      return {
        ...stores,
        model: { ...catalogModel, provider, id: modelId, name: modelId },
        logicalRef: { provider, model: modelId },
      };
    }
    return {
      ...stores,
      error: `Unknown model: ${provider}/${modelId}`,
    };
  },
);

vi.mock("./model.js", () => ({
  createEmptyAgentDiscoveryStores: () => ({ authStorage, modelRegistry }),
  resolveModelAsync: resolveModelAsyncMock,
}));

vi.mock("../provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeModel,
}));

vi.mock("../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: loadManifest,
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: vi.fn(() => ({
    id: "openclaw",
    label: "OpenClaw",
    supports: () => ({ supported: true }),
    runAttempt: vi.fn(),
  })),
}));

vi.mock("../prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot: vi.fn(),
}));

vi.mock("./run/setup.js", () => ({
  buildBeforeModelResolveAttachments: vi.fn(() => []),
  createNativeModelOwnedRuntimeModel: vi.fn(),
  resolveHookModelSelection: selectModelHook,
}));

vi.mock("./compaction-runtime-preparation.js", () => ({
  resolveCompactionRuntimeSelection: ({
    provider,
    modelId,
  }: {
    provider: string;
    modelId: string;
  }) => ({
    runtimePolicySessionKey: "agent:main:test",
    runtimePolicyAgentId: "main",
    boundHarnessRuntime: undefined,
    selectedHarnessRuntimeOverride: undefined,
    runtimeModelAuth: { plan: undefined, authProfileId: undefined, modelAuth: undefined },
    provider,
    runtimeProvider: provider,
    contextConfigProvider: provider,
    modelId,
  }),
  prepareCompactionHarnessAuth: vi.fn(async () => ({
    ok: true,
    runtimeAuthProfileStore: {},
    runtimeAuthPreparation: {
      plan: { selectedAuthMode: "api-key" },
      attempts: [{ kind: "direct", plan: { selectedAuthMode: "api-key" } }],
    },
    selectedPreparedHarness: { id: "openclaw" },
    providerUsesProfileScopedModelMetadata: false,
  })),
}));

vi.mock("../runtime-plan/resolve-auth.js", () => ({
  resolvePreparedRuntimeAuthAttempts: vi.fn(async ({ model, attempts }) => ({
    model,
    auth: { apiKey: "test-api-key", mode: "api_key", source: "test" },
    plan: attempts[0].plan,
  })),
  resolvePreparedRuntimeModelAuth: vi.fn(),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  prepareProviderRuntimeAuth: vi.fn(async () => undefined),
}));

vi.mock("../provider-runtime-auth-protection.js", () => ({
  protectPreparedProviderRuntimeAuth: (value: unknown) => value,
}));

vi.mock("../provider-secret-egress.js", () => ({
  unwrapSecretSentinelsForProviderEgress: (value: unknown) => value,
  unwrapModelHeaderSentinelsForProviderEgress: (model: unknown) => model,
}));

vi.mock("../provider-request-config.js", () => ({
  applyPreparedRuntimeAuthToModel: (model: unknown) => model,
}));

vi.mock("../sandbox/context.js", async () => ({
  ...(await vi.importActual<typeof import("../sandbox/context.js")>("../sandbox/context.js")),
  resolveSandboxContext: vi.fn(async () => undefined),
}));

vi.mock("./compaction-runtime-context.js", () => ({
  resolveEmbeddedCompactionThinkingLevel: resolveThinking,
}));

vi.mock("./logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logger.js")>();
  return {
    ...actual,
    log: { ...actual.log, warn },
  };
});

const { resolveEmbeddedRunModelSetup: setupModel } = await import("./run/model-setup.js");
const { prepareDirectCompactionAttempt } = await import("./direct-compaction-preparation.js");
const { prepareCompactionHarnessAuth } = await import("./compaction-runtime-preparation.js");

function prepareCompaction(
  runtime: ReturnType<typeof preparedRuntime>,
  provider = PROVIDER,
  model = STATIC_MODEL_ID,
) {
  return prepareDirectCompactionAttempt({
    config: runtime.config,
    provider,
    model,
    agentId: "main",
    sessionId: "compact-session",
    sessionKey: "agent:main:compact-session",
    sessionFile: "agent:main:compact-session",
    workspaceDir: runtime.workspaceDir,
    preparedModelRuntime: runtime as never,
  });
}

function catalogEntry(
  api: string,
  baseUrl: string,
  compat?: ModelCatalogEntry["compat"],
): ModelCatalogEntry {
  return {
    provider: PROVIDER,
    id: STATIC_MODEL_ID,
    name: STATIC_MODEL_ID,
    api,
    baseUrl,
    ...(compat ? { compat } : {}),
  };
}
const route = { api: catalogModel.api, baseUrl: catalogModel.baseUrl };
const thinkingCompat = { supportedReasoningEfforts: ["max", "ultra"] } as const;
function capability(agentRuntime = "openclaw") {
  return {
    provider: PROVIDER,
    modelId: STATIC_MODEL_ID,
    agentRuntime,
    route,
    compat: thinkingCompat,
  };
}
function expectDiscoveryDeferred() {
  expect(loadManifest).not.toHaveBeenCalled();
  expect(normalizeModel).not.toHaveBeenCalled();
}

function preparedRuntime(config: Record<string, unknown>) {
  return {
    agentDir: "/tmp/agents/main/agent",
    config,
    workspaceDir: "/tmp/openclaw-model-resolution",
    pluginRegistry: {},
    configuredRuntimeModels: [],
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
    createStores: () => ({ authStorage, modelRegistry }),
  };
}

describe("embedded model resolution consistency", () => {
  beforeEach(() => {
    warn.mockClear();
    selectModelHook.mockClear();
    loadManifest.mockReset();
    normalizeModel.mockReset().mockReturnValue(undefined);
  });

  it("resolves an explicit alias configured only on the selected agent", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": { alias: "global-luna" } },
        },
        entries: {
          worker: {
            models: { "anthropic/claude-haiku-4-5": { alias: "worker-haiku" } },
          },
        },
      },
    };

    expect(
      initialModel({
        config,
        agentId: "worker",
        model: "worker-haiku",
      }),
    ).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });
    expectDiscoveryDeferred();
  });

  it("defers custom-provider normalization until prepared manifest policy is available", () => {
    const config = {
      agents: {
        entries: {
          worker: {
            model: { primary: "worker-custom" },
            models: {
              "custom-provider/legacy-model": { alias: "worker-custom" },
            },
          },
        },
      },
    };
    const initial = initialModel({
      config,
      agentId: "worker",
    });

    expect(initial).toEqual({
      provider: "custom-provider",
      modelId: "legacy-model",
    });
    expectDiscoveryDeferred();

    const manifestPlugins = [
      {
        modelIdNormalization: {
          providers: {
            "custom-provider": {
              aliases: { "legacy-model": "modern-model", "modern-model": "unexpected-second-pass" },
            },
          },
        },
      },
    ];
    expect(
      modelChain({
        cfg: config,
        agentId: "worker",
        provider: initial.provider,
        model: initial.modelId,
        requestedRouteResolution: "raw",
        fallbacksOverride: [],
        manifestPlugins,
      }),
    ).toEqual([
      {
        provider: "custom-provider",
        model: "modern-model",
        routeOrigin: "requested",
        routeResolution: "resolved",
      },
    ]);
    expect(normalizeModel).toHaveBeenCalledWith({
      provider: "custom-provider",
      context: {
        provider: "custom-provider",
        modelId: "modern-model",
      },
    });
  });

  it("resolves the same undated configured model for chat and manual compaction", async () => {
    const config = {
      agents: { defaults: { model: { primary: `${PROVIDER}/${STATIC_MODEL_ID}` } } },
    };
    const target = initialModel({ config });
    const preparedModelRuntime = preparedRuntime(config);

    const chat = await setupModel({
      assertCurrent: () => {},
      runParams: {
        config,
        prompt: "hello",
        sessionId: "chat-session",
        agentId: "main",
      } as never,
      ...target,
      agentDir: preparedModelRuntime.agentDir,
      workspaceDir: preparedModelRuntime.workspaceDir,
      globalLane: "test",
      hookRunner: undefined,
      hookContext: {} as never,
      onHooksResolved: vi.fn(),
      preparedModelRuntime: preparedModelRuntime as never,
    });
    expect(chat.model).toMatchObject({
      provider: PROVIDER,
      id: STATIC_MODEL_ID,
      compactionThinkingDefault: "off",
    });

    const compaction = await prepareCompaction(
      preparedModelRuntime,
      target.provider,
      target.modelId,
    );

    expect(modelRegistry.find(PROVIDER, STATIC_MODEL_ID)).toBeNull();
    if (!compaction.ok) {
      throw new Error(`manual compaction failed: ${compaction.result.reason}`);
    }
    expect(compaction.value.runtimeModel).toMatchObject({
      provider: PROVIDER,
      id: STATIC_MODEL_ID,
    });
    expect(resolveThinking).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: PROVIDER,
        modelId: STATIC_MODEL_ID,
        compactionThinkingDefault: "off",
      }),
    );
  });

  it.each([
    {
      name: "unresolved model",
      provider: "test-provider",
      model: "missing-compaction-model",
      reason: "Provider-specific model resolution failed",
      logReason: "compaction_model_unresolved",
    },
    {
      name: "auth failure",
      provider: PROVIDER,
      model: STATIC_MODEL_ID,
      reason: "private_compaction_auth_payload",
      logReason: "unknown",
    },
  ])(
    "returns $name details without logging provider prose",
    async ({ provider, model, reason, logReason }) => {
      if (logReason === "unknown") {
        vi.mocked(prepareCompactionHarnessAuth).mockResolvedValueOnce({
          ok: false,
          error: new Error(reason),
        });
      }
      const result = await prepareCompaction(preparedRuntime({}), provider, model);
      expect(result).toMatchObject({ ok: false, result: { ok: false, compacted: false, reason } });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`outcome=failed reason=${logReason} `),
      );
      if (logReason === "unknown") {
        expect(JSON.stringify(warn.mock.calls)).not.toContain(reason);
      } else {
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(" detail="));
      }
    },
  );

  it("keeps configured provider routes off harness-scoped thinking capability", () => {
    const compat = thinkingCompat;
    const preparedCatalog = [
      catalogEntry("openai-chatgpt-responses", "https://chatgpt.example/codex", compat),
    ];
    const configuredCatalog = [catalogEntry("anthropic-messages", catalogModel.baseUrl)];

    expect(
      prepareModelRunCapabilities(
        [preparedCatalog, configuredCatalog],
        [PROVIDER, STATIC_MODEL_ID, "codex"],
      ).modelThinkingCapability,
    ).toEqual({
      provider: PROVIDER,
      modelId: STATIC_MODEL_ID,
      agentRuntime: "codex",
      compat,
    });
  });

  const routeEfforts = { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] };
  it.each([
    ["matching route", {}, "openclaw", "route", routeEfforts],
    [
      "prepared auth route",
      { api: "openai-responses", baseUrl: "https://api.example/v1" },
      "codex",
      "harness",
      thinkingCompat,
    ],
    ["different model", { id: "hook-rerouted-model" }, "openclaw", "route", undefined],
    [
      "different physical route",
      { baseUrl: "https://other.example/v1" },
      "openclaw",
      "route",
      undefined,
    ],
    ["different harness", {}, "codex", "route", undefined],
  ] as const)(
    "resolves prepared compatibility for %s",
    (_name, model, agentRuntime, scope, expected) => {
      const prepared =
        scope === "harness"
          ? { ...capability("codex"), route: undefined }
          : { ...capability(), compat: expected ?? { supportedReasoningEfforts: ["max"] } };
      expect(
        thinkingCompatForModel({
          capability: prepared,
          model: { ...catalogModel, ...model },
          agentRuntime,
        }),
      ).toEqual(expected);
    },
  );
});
