// Broad coverage for embedded runner model resolution behavior.
import fs from "node:fs";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { discoverAuthStorage, discoverModels } from "../agent-model-discovery.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../auth-profiles.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../plugin-model-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.owner.js";
import { registerModelAuthReadTests } from "./model.auth-read.test-support.js";
import {
  createEmptyPreparedModelRuntimeFixture,
  guardModelFixtureAuth,
} from "./model.fixture.test-support.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { createPreparedConfiguredRuntimeModelLookup } from "./model.static-id.js";

let state: OpenClawTestState;
let auth: ReturnType<typeof guardModelFixtureAuth>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "model-resolution" });
  auth = guardModelFixtureAuth(state.root);
});
afterEach(async () => {
  try {
    auth.verify();
  } finally {
    auth.spy.mockRestore();
    clearRuntimeAuthProfileStoreSnapshots();
    await state.cleanup();
  }
});

const resolveBundledStaticCatalogModelMock = vi.hoisted(() => vi.fn());
const resolveBundledProviderStaticCatalogModelMock = vi.hoisted(() => vi.fn());
const resolveManifestModelCatalogProviderAliasMetadataMock = vi.hoisted(() =>
  vi.fn<
    (params: {
      provider: string;
      cfg?: { models?: { providers?: Record<string, { baseUrl?: string }> } };
    }) => {
      ambiguous?: true;
      provider: string;
      transport?: { api?: "azure-openai-responses"; baseUrl?: string };
    }
  >(),
);
const preparedSnapshotState = vi.hoisted(() => ({
  enabled: true,
  getInputs: [] as Array<Record<string, unknown>>,
  snapshots: new Map<string, unknown>(),
  configuredRuntimeModels: [] as PreparedModelRuntimeSnapshot["configuredRuntimeModels"],
  inlineProviderModels: [] as PreparedModelRuntimeSnapshot["inlineProviderModels"],
}));

vi.mock("../../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => {},
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

vi.mock("../model-suppression.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../model-suppression.js")>();
  // Mirrors the canonical manifest-driven suppression in
  // extensions/qwen/openclaw.plugin.json and src/plugins/manifest-model-suppression.ts.
  function isQwenCodingPlanBaseUrl(value: string | undefined): boolean {
    const trimmed = value?.trim();
    if (!trimmed) {
      return false;
    }
    try {
      const hostname = new URL(trimmed).hostname.toLowerCase().replace(/\.+$/, "");
      return (
        hostname === "coding.dashscope.aliyuncs.com" ||
        hostname === "coding-intl.dashscope.aliyuncs.com"
      );
    } catch {
      return false;
    }
  }

  function resolveConfiguredQwenBaseUrl(config: unknown): string | undefined {
    const providers = (config as { models?: { providers?: Record<string, { baseUrl?: string }> } })
      ?.models?.providers;
    if (!providers) {
      return undefined;
    }
    for (const [provider, entry] of Object.entries(providers)) {
      const normalizedProvider = provider.trim().toLowerCase();
      if (normalizedProvider !== "qwen" && normalizedProvider !== "modelstudio") {
        continue;
      }
      const baseUrl = entry?.baseUrl?.trim();
      if (baseUrl) {
        return baseUrl;
      }
    }
    return undefined;
  }

  return {
    ...actual,
    shouldUnconditionallySuppress: ({ provider, id }: { provider?: string; id?: string }) => {
      if (
        (provider === "openai" || provider === "azure-openai-responses" || provider === "openai") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return true;
      }
      return false;
    },
    buildSuppressedBuiltInModelError: ({
      provider,
      id,
      config,
    }: {
      provider?: string;
      id?: string;
      config?: unknown;
    }) => {
      if (
        (provider === "qwen" || provider === "modelstudio") &&
        id?.trim().toLowerCase() === "qwen3.6-plus" &&
        isQwenCodingPlanBaseUrl(resolveConfiguredQwenBaseUrl(config))
      ) {
        return "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.";
      }
      if (
        (provider === "openai" || provider === "azure-openai-responses" || provider === "openai") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run \`openclaw models auth login --provider openai\` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.`;
      }
      return undefined;
    },
  };
});

vi.mock("../prepared-model-runtime.js", async () => {
  const discovery = await import("../agent-model-discovery.js");
  const discoveryContext = await import("../model-discovery-context.js");
  const { PreparedModelRuntimeOwnerNotPublishedError } =
    await import("../prepared-model-runtime.errors.js");
  const createSnapshot = (input: {
    agentId?: string;
    agentDir: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
  }) => {
    const workspaceDir = discoveryContext.resolveModelWorkspaceDir(
      input.config,
      input.workspaceDir,
    );
    const key = `${input.agentId ?? ""}\u0000${input.agentDir}\u0000${workspaceDir ?? ""}`;
    const current = preparedSnapshotState.snapshots.get(key);
    if (current) {
      return current;
    }
    const authStorage = discovery.discoverAuthStorage(input.agentDir);
    const modelRegistry = discovery.discoverModels(authStorage, input.agentDir, {
      ...(input.config ? { config: input.config } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    });
    if (!("fork" in modelRegistry)) {
      Object.assign(modelRegistry, { fork: () => modelRegistry });
    }
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const snapshot = {
      catalogOwner: undefined,
      agentDir: input.agentDir,
      ...(workspaceDir ? { workspaceDir } : {}),
      activeProjectKeys: [],
      config: input.config ?? {},
      authModes: {},
      metadataSnapshot,
      allowGatewaySubagentBinding: false,
      modelCatalog: { entries: [], routeVariants: [] },
      configuredRuntimeModels: preparedSnapshotState.configuredRuntimeModels,
      findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
        preparedSnapshotState.configuredRuntimeModels,
        metadataSnapshot,
      ),
      inlineProviderModels: preparedSnapshotState.inlineProviderModels,
      createStores: () => ({ authStorage, modelRegistry }),
    };
    preparedSnapshotState.snapshots.set(key, snapshot);
    return snapshot;
  };
  return {
    PreparedModelRuntimeOwnerNotPublishedError,
    getPreparedModelRuntimeSnapshot: (input: Parameters<typeof createSnapshot>[0]) => {
      preparedSnapshotState.getInputs.push(input);
      return preparedSnapshotState.enabled ? createSnapshot(input) : undefined;
    },
    loadPreparedModelRuntimeSnapshot: async (input: Parameters<typeof createSnapshot>[0]) =>
      createSnapshot(input),
  };
});

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

vi.mock("./model.static-catalog.js", () => ({
  canonicalizeManifestModelCatalogProviderAlias: (params: { provider: string }) =>
    resolveManifestModelCatalogProviderAliasMetadataMock(params).provider,
  resolveBundledProviderStaticCatalogModel: resolveBundledProviderStaticCatalogModelMock,
  resolveBundledStaticCatalogModel: resolveBundledStaticCatalogModelMock,
  resolveManifestModelCatalogProviderAliasMetadata:
    resolveManifestModelCatalogProviderAliasMetadataMock,
  resolveManifestModelCatalogProviderTransport: (params: { provider: string }) =>
    resolveManifestModelCatalogProviderAliasMetadataMock(params).transport,
}));

import type { OpenClawConfig, OpenClawConfigInput } from "../../config/config.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { Model } from "../../llm/types.js";
import { getModelProviderLocalService } from "../provider-local-service.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import {
  applyConfiguredProviderOverrides,
  findInlineModelMatch,
} from "./model.configured-overrides.js";
import {
  buildForwardCompatTemplate,
  expectUnknownModelErrorResult,
} from "./model.forward-compat.test-support.js";
import { buildInlineProviderModels } from "./model.inline-provider.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
  resolveModelWithRegistry,
} from "./model.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeOpenClawConfigFixture,
  makeModel,
  mockDiscoveredModel,
  OPENAI_CODEX_TEMPLATE_MODEL,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  preparedSnapshotState.enabled = true;
  preparedSnapshotState.getInputs.length = 0;
  preparedSnapshotState.snapshots.clear();
  preparedSnapshotState.configuredRuntimeModels = [];
  preparedSnapshotState.inlineProviderModels = [];
  clearRuntimeAuthProfileStoreSnapshots();
  resetMockDiscoverModels(discoverModels);
  vi.mocked(discoverModels).mockClear();
  vi.mocked(discoverAuthStorage).mockClear();
  resolveBundledStaticCatalogModelMock.mockReset();
  resolveBundledProviderStaticCatalogModelMock.mockReset();
  resolveManifestModelCatalogProviderAliasMetadataMock.mockReset();
  resolveManifestModelCatalogProviderAliasMetadataMock.mockImplementation(({ provider, cfg }) => {
    const normalized = provider.trim().toLowerCase();
    const canonicalProvider =
      normalized === "moonshotai" || normalized === "moonshot-ai" ? "moonshot" : provider;
    const transport =
      provider === "azure-openai-responses" && cfg?.models?.providers?.[provider]?.baseUrl
        ? { api: "azure-openai-responses" as const }
        : undefined;
    return {
      provider: canonicalProvider,
      ...(transport ? { transport } : {}),
    };
  });
});

function createRuntimeHooks() {
  // Keep model-resolution tests independent of provider execution runtimes.
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["openrouter", "github-copilot", "openai", "anthropic", "zai"],
  });
}

async function resolveModelForTest(
  provider: string,
  modelId: string,
  cfg?: OpenClawConfig,
  options?: Parameters<typeof resolveModelAsync>[4],
) {
  // Most tests use fixed auth storage to keep assertions focused on model
  // resolution rather than auth discovery.
  const agentDir = state.agentDir();
  return await resolveModelAsync(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: discoverModels({ mocked: true } as never, agentDir),
    ...options,
    runtimeHooks: options?.runtimeHooks ?? createRuntimeHooks(),
  });
}

type ResolveModelForTestResult = Awaited<ReturnType<typeof resolveModelForTest>>;

function expectResolvedModel(result: ResolveModelForTestResult) {
  if (result.error !== undefined) {
    throw new Error(`expected model resolution to succeed, got error: ${result.error}`);
  }
  if (!result.model) {
    throw new Error("expected model resolution to return a model");
  }
  return result.model;
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[0] as Record<string, unknown>;
}

function mockMinimalModelDiscovery(
  provider: string,
  modelId: string,
  overrides: Record<string, unknown> = {},
) {
  mockDiscoveredModel(discoverModels, {
    provider,
    modelId,
    templateModel: { ...makeModel(modelId), provider, ...overrides },
  });
}

function makeProviderConfig(
  provider: string,
  overrides: Record<string, unknown> = {},
): OpenClawConfig {
  return makeOpenClawConfigFixture({
    models: {
      providers: {
        [provider]: { models: [], ...overrides },
      },
    },
  });
}

function makeOpenAIStaticModel(): Model {
  return {
    ...makeModel("gpt-5.5"),
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };
}

function createAzureRuntimeHooks() {
  return {
    ...createRuntimeHooks(),
    runProviderDynamicModel: vi.fn<ProviderRuntimeHooks["runProviderDynamicModel"]>(
      ({ provider, context }) =>
        provider === "azure-openai-responses" && context.modelId === "gpt-5.5"
          ? makeOpenAIStaticModel()
          : undefined,
    ),
  };
}

const deepSeekCatalogCompat = {
  supportsUsageInStreaming: true,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens" as const,
};

function makeDeepSeekCatalogModel(overrides: Partial<Model> = {}): Model {
  const { compat, ...modelOverrides } = overrides;
  return {
    provider: "deepseek",
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    ...modelOverrides,
    ...(compat ? { compat: { ...deepSeekCatalogCompat, ...compat } } : {}),
  };
}

function makeXiaomiCatalogModel(overrides: Partial<Model> = {}): Model {
  return {
    provider: "xiaomi-token-plan",
    id: "mimo-v2.5-pro",
    name: "Xiaomi MiMo V2.5 Pro",
    api: "openai-completions",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_000,
    ...overrides,
  };
}

function makeConfiguredDeepSeekModel(
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  const { compat, ...modelOverrides } = overrides;
  return {
    ...makeModel("deepseek-v4-pro"),
    name: "Custom DeepSeek V4 Pro",
    contextWindow: 32_768,
    maxTokens: 4_096,
    ...modelOverrides,
    ...(compat ? { compat: { ...compat } } : {}),
  };
}

function makeDeepSeekConfig(
  modelOverrides: Partial<ModelDefinitionConfig> = {},
  providerOverrides: Partial<ModelProviderConfig> = {},
): OpenClawConfig {
  return makeProviderConfig("deepseek", {
    models: [makeConfiguredDeepSeekModel(modelOverrides)],
    ...providerOverrides,
  });
}

function makeVllmQwenConfig(): OpenClawConfig {
  return makeProviderConfig("vllm", {
    baseUrl: "http://localhost:9000",
    api: "openai-completions",
    models: [
      {
        id: "Qwen/Qwen3-8B",
        name: "Qwen/Qwen3-8B",
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ],
  });
}

describe("resolveModel", () => {
  registerModelAuthReadTests({
    getAgentDir: () => state.agentDir(),
    getAuthSpy: () => auth.spy,
    createRuntimeHooks,
    makeProviderConfig,
    expectResolvedModel,
    expectRecordFields,
  });

  it.each([
    {
      description: "keeps explicit configured models ahead of prepared models",
      preferRuntime: false,
      expectedName: "Configured Model",
      expectedPreparationCount: 0,
    },
    {
      description: "preserves manually configured limits during runtime comparison",
      preferRuntime: true,
      expectedName: "Prepared Model",
      expectedPreparationCount: 1,
    },
    {
      description: "replaces models-add metadata with a preferred prepared model",
      preferRuntime: true,
      metadataSource: "models-add" as const,
      expectedName: "Prepared Model",
      expectedPreparationCount: 1,
    },
  ])(
    "$description",
    async ({ preferRuntime, metadataSource, expectedName, expectedPreparationCount }) => {
      const prepareProviderDynamicModel = vi.fn(async () => ({
        ...makeModel("prepared-model"),
        provider: "acme",
        name: "Prepared Model",
        api: "openai-completions" as const,
        baseUrl: "https://discovered.example/v1",
        input: ["text" as const],
        contextWindow: 65_536,
        maxTokens: 8_192,
      }));
      const runProviderDynamicModel = vi.fn(() => undefined);
      const cfg = makeProviderConfig("acme", {
        api: "openai-responses",
        baseUrl: "https://configured.example/v1",
        models: [
          {
            ...makeModel("prepared-model"),
            name: "Configured Model",
            contextWindow: 32_768,
            maxTokens: 4_096,
            ...(metadataSource ? { metadataSource } : {}),
          },
        ],
      });
      if (!preferRuntime) {
        auth.spy.mockImplementation(() => {
          throw new Error("Explicit model resolution must not read auth storage");
        });
      }

      const result = await resolveModelAsync("acme", "prepared-model", state.agentDir(), cfg, {
        runtimeHooks: {
          ...createRuntimeHooks(),
          prepareProviderDynamicModel,
          runProviderDynamicModel,
          shouldPreferProviderRuntimeResolvedModel: () => preferRuntime,
        },
        skipAgentDiscovery: true,
      });

      expectRecordFields(expectResolvedModel(result), {
        name: expectedName,
        api: "openai-responses",
        baseUrl: "https://configured.example/v1",
        contextWindow: metadataSource ? 65_536 : 32_768,
      });
      expect(prepareProviderDynamicModel).toHaveBeenCalledTimes(expectedPreparationCount);
      expect(runProviderDynamicModel).not.toHaveBeenCalled();
    },
  );

  it("looks up the lifecycle owner before applying a derived workspace", async () => {
    mockMinimalModelDiscovery("openai", "gpt-5.5");
    const cfg = {
      agents: { defaults: { workspace: state.path("config-derived-workspace") } },
    } as OpenClawConfig;

    const result = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), cfg, {
      agentId: "main",
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(result);
    expect(preparedSnapshotState.getInputs[0]).toEqual(
      expect.objectContaining({ agentId: "main", agentDir: state.agentDir() }),
    );
    expect(preparedSnapshotState.getInputs[0]).not.toHaveProperty("workspaceDir");
  });

  it("does not poll generated plugin catalogs between lifecycle generations", async () => {
    const agentDir = state.agentDir();
    fs.mkdirSync(agentDir, { recursive: true });
    mockDiscoveredModel(discoverModels, {
      provider: "zai",
      modelId: "glm-5.1",
      templateModel: {
        provider: "zai",
        ...makeModel("glm-5.1"),
      },
    });

    const first = await resolveModelAsync("zai", "glm-5.1", agentDir, undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: {},
        }),
      },
    });
    const second = await resolveModelAsync("zai", "glm-5.1", agentDir, undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("reuses inherited auth from one lifecycle generation", async () => {
    const agentDir = state.agentDir("worker");
    const defaultAgentDir = state.agentDir();
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(defaultAgentDir, { recursive: true });
    const cfg = makeOpenClawConfigFixture({
      agents: {
        list: [
          { id: "main", default: true, agentDir: defaultAgentDir },
          { id: "worker", agentDir },
        ],
      },
    });
    mockMinimalModelDiscovery("openai", "gpt-5.5");

    const first = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "one" } },
      },
      defaultAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const second = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("uses the resolved default agent directory and workspace for prepared discovery", async () => {
    const agentDir = state.agentDir("workspace-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const cfg = makeOpenClawConfigFixture({
      agents: {
        list: [{ id: "workspace-agent", default: true, agentDir, workspace: state.workspaceDir }],
      },
    });
    mockMinimalModelDiscovery("openai", "gpt-5.5");
    const result = await resolveModelAsync("openai", "gpt-5.5", undefined, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });
    expectResolvedModel(result);
    expect(discoverModels).toHaveBeenCalledWith(
      expect.anything(),
      agentDir,
      expect.objectContaining({ workspaceDir: state.workspaceDir }),
    );
  });

  it("passes config into model discovery when auth storage is prebuilt", async () => {
    const agentDir = state.agentDir("configured");
    const workspaceDir = state.path("workspace-configured");
    const authStorage = { mocked: true } as never;
    const cfg = makeProviderConfig("openai", {
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      models: [{ id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" }],
    });
    mockMinimalModelDiscovery("openai", "gpt-5.5");

    const options = {
      authStorage,
      workspaceDir,
      runtimeHooks: createRuntimeHooks(),
    };
    const result = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, options);

    expectResolvedModel(result);
    expect(discoverModels).toHaveBeenCalledWith(authStorage, agentDir, {
      config: cfg,
      workspaceDir,
    });
  });

  it("keeps runtime auth snapshots inside the lifecycle generation", async () => {
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        store: {
          version: 1,
          profiles: {
            openai: { type: "api_key", key: "one" },
          },
        } as never,
      },
    ]);
    mockMinimalModelDiscovery("openai", "gpt-5.5");

    const first = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      runtimeHooks: createRuntimeHooks(),
    });
    const second = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
      runtimeHooks: createRuntimeHooks(),
    });

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("resolves configured inline models from one prepared generation", async () => {
    const cfg = makeProviderConfig("deepseek", {
      api: "openai-completions",
      models: [{ id: "deepseek-v4-pro", name: "Configured DeepSeek" }],
    });
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const configuredRuntimeModels = [
      {
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        model: makeDeepSeekCatalogModel(),
      },
    ];
    const preparedModelRuntime = {
      ...createEmptyPreparedModelRuntimeFixture({
        agentDir: state.agentDir(),
        config: cfg,
        metadataSnapshot,
        createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
      }),
      configuredRuntimeModels,
      findConfiguredRuntimeModel: createPreparedConfiguredRuntimeModelLookup(
        configuredRuntimeModels,
        metadataSnapshot,
      ),
      inlineProviderModels: buildInlineProviderModels(cfg.models?.providers ?? {}),
    } satisfies PreparedModelRuntimeSnapshot;

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", state.agentDir(), cfg, {
      authStorage: { mocked: true } as never,
      modelRegistry: { find: vi.fn(() => null) } as never,
      preparedModelRuntime,
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      name: "Configured DeepSeek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
    });
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(resolveBundledProviderStaticCatalogModelMock).not.toHaveBeenCalled();
  });

  it("keeps request transport ahead of another config's prepared inline facts", async () => {
    const preparedConfig = makeProviderConfig("custom", {
      api: "openai-completions",
      baseUrl: "https://prepared.example/v1",
      headers: { "X-Retired": "prepared" },
      models: [{ id: "model-a", name: "Prepared model" }],
    });
    preparedSnapshotState.inlineProviderModels = buildInlineProviderModels(
      preparedConfig.models?.providers ?? {},
    );
    const runtimeHooks = {
      ...createRuntimeHooks(),
      normalizeProviderTransportWithPlugin: () => undefined,
    };
    await resolveModelAsync("custom", "model-a", state.agentDir(), preparedConfig, {
      runtimeHooks,
    });
    const cfg = makeProviderConfig("custom", {
      api: "openai-responses",
      baseUrl: "https://request.example/v1",
      models: [{ id: "model-a", name: "Requested model" }],
    });
    const result = await resolveModelAsync("custom", "model-a", state.agentDir(), cfg, {
      runtimeHooks,
    });
    expectRecordFields(expectResolvedModel(result), {
      id: "model-a",
      api: "openai-responses",
      baseUrl: "https://request.example/v1",
    });
    expect(expectResolvedModel(result).headers?.["X-Retired"]).toBeUndefined();
    expect(discoverModels).toHaveBeenCalledOnce();
  });

  it("resolves opt-in provider static catalog rows while skipping agent discovery", async () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const config = {};
    const preparedModelRuntime = createEmptyPreparedModelRuntimeFixture({
      agentDir: state.agentDir(),
      config,
      metadataSnapshot,
      createStores: createEmptyAgentDiscoveryStores,
    });
    resolveBundledProviderStaticCatalogModelMock.mockResolvedValueOnce({
      provider: "google",
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro Preview",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });

    const result = await resolveModelAsync(
      "google",
      "gemini-3.1-pro-preview",
      state.agentDir(),
      undefined,
      {
        allowBundledStaticCatalogFallback: true,
        preparedModelRuntime,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expectRecordFields(expectResolvedModel(result), {
      provider: "google",
      id: "gemini-3.1-pro-preview",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      cfg: undefined,
      workspaceDir: undefined,
      includeRuntimeDiscovery: true,
      metadataSnapshot,
    });
    expect(resolveBundledProviderStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
      cfg: undefined,
      workspaceDir: undefined,
      metadataSnapshot,
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("falls back to bundled static catalog rows without agent discovery", async () => {
    const cfg = makeProviderConfig("openai", {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      models: [],
    });
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "openai",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
    const runProviderDynamicModel = vi.fn(() => undefined);

    const result = await resolveModelAsync("openai", "gpt-5.3-codex", state.agentDir(), cfg, {
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
      runtimeHooks: {
        ...baseRuntimeHooks,
        prepareProviderDynamicModel,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "openai",
      id: "gpt-5.3-codex",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledTimes(1);
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.3-codex",
        cfg,
      }),
    );
    expect(prepareProviderDynamicModel).toHaveBeenCalled();
    expect(runProviderDynamicModel).toHaveBeenCalled();
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it.each([undefined, "openai:prepared"])(
    "keeps the prepared auth mode through async provider model resolution (profile %s)",
    async (authProfileId) => {
      auth.spy.mockImplementation(() => {
        throw new Error("Prepared auth mode must not read auth storage");
      });
      const baseRuntimeHooks = createRuntimeHooks();
      const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
      const runProviderDynamicModel = vi.fn(
        (params: { context: { authProfileMode?: string } }) => ({
          provider: "openai",
          ...makeModel("gpt-5.5"),
          api:
            params.context.authProfileMode === "api_key"
              ? ("openai-responses" as const)
              : ("openai-chatgpt-responses" as const),
          baseUrl:
            params.context.authProfileMode === "api_key"
              ? "https://api.openai.com/v1"
              : "https://chatgpt.com/backend-api",
        }),
      );

      const result = await resolveModelAsync("openai", "gpt-5.5", state.agentDir(), undefined, {
        authProfileId,
        authProfileMode: "api_key",
        runtimeHooks: {
          ...baseRuntimeHooks,
          prepareProviderDynamicModel,
          runProviderDynamicModel,
        },
        skipAgentDiscovery: true,
      });

      expectRecordFields(expectResolvedModel(result), {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      expectRecordFields(mockCallArg(prepareProviderDynamicModel).context, {
        ...(authProfileId ? { authProfileId } : {}),
        authProfileMode: "api_key",
      });
      expectRecordFields(mockCallArg(runProviderDynamicModel).context, {
        ...(authProfileId ? { authProfileId } : {}),
        authProfileMode: "api_key",
      });
    },
  );

  it("looks up each static fallback candidate with its own normalized model id", async () => {
    resolveBundledStaticCatalogModelMock.mockImplementation(({ provider, modelId }) => ({
      provider,
      id: modelId,
      name: modelId,
      api: "openai-responses",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const resolve = (provider: string, id: string) =>
      resolveModelAsync(provider, id, state.agentDir(), undefined, {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
        skipProviderRuntimeHooks: true,
      });
    const anthropicResult = await resolve("anthropic", "anthropic/claude-haiku-4-5");
    const openaiResult = await resolve("openai", "gpt-4o");
    expectRecordFields(expectResolvedModel(anthropicResult), {
      provider: "anthropic",
      id: "claude-haiku-4-5",
    });
    expectRecordFields(expectResolvedModel(openaiResult), { provider: "openai", id: "gpt-4o" });
    expect(resolveBundledStaticCatalogModelMock.mock.calls).toEqual([
      [
        {
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          cfg: undefined,
          workspaceDir: undefined,
          includeRuntimeDiscovery: true,
        },
      ],
      [
        {
          provider: "openai",
          modelId: "gpt-4o",
          cfg: undefined,
          workspaceDir: undefined,
          includeRuntimeDiscovery: true,
        },
      ],
    ]);
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("applies provider overrides to bundled static catalog rows while skipping agent discovery", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      provider: "mistral",
      id: "mistral-medium-3-5",
      name: "Mistral Medium 3.5",
      api: "openai-completions",
      baseUrl: "https://api.mistral.ai/v1",
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 8192,
      mediaInput: {
        image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
      },
    });
    const cfg = makeProviderConfig("mistral", {
      baseUrl: "https://mistral-proxy.example.com/v1",
      api: "openai-completions",
      headers: { "X-Proxy": "static-fast-path" },
      request: { proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:18080" } },
      localService: {
        command: "/opt/mistral/start",
        args: ["--port", "18080"],
        healthUrl: "http://127.0.0.1:18080/health",
      },
      models: [],
    });

    const result = await resolveModelAsync("mistral", "mistral-medium-3-5", state.agentDir(), cfg, {
      allowBundledStaticCatalogFallback: true,
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expect(model.baseUrl).toBe("https://mistral-proxy.example.com/v1");
    expect(model.headers).toEqual({ "X-Proxy": "static-fast-path" });
    expect(getModelProviderRequestTransport(model)).toEqual({
      proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:18080" },
    });
    expect(getModelProviderLocalService(model)).toEqual({
      command: "/opt/mistral/start",
      args: ["--port", "18080"],
      healthUrl: "http://127.0.0.1:18080/health",
    });
    expect(discoverAuthStorage).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("merges bundled static media input into resolved models when opted in", async () => {
    const discoveredModel = {
      ...makeModel("gpt-5.5-pro"),
      name: "GPT-5.5 Pro",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 272_000,
      maxTokens: 128_000,
    };
    mockDiscoveredModel(discoverModels, {
      provider: "openai",
      modelId: "gpt-5.5-pro",
      templateModel: discoveredModel,
    });
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      ...discoveredModel,
      mediaInput: {
        image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
      },
    });
    const result = await resolveModelForTest("openai", "gpt-5.5-pro", undefined, {
      allowBundledStaticCatalogFallback: true,
      skipAgentDiscovery: true,
    });
    expect(expectResolvedModel(result).mediaInput).toEqual({
      image: { maxSidePx: 6000, preferredSidePx: 2048, tokenMode: "detail" },
    });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.5-pro",
      cfg: undefined,
      workspaceDir: undefined,
      includeRuntimeDiscovery: true,
    });
  });

  it("merges configured media input with discovered model metadata", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "vision-model",
      templateModel: {
        id: "vision-model",
        name: "Vision Model",
        provider: "custom",
        api: "openai-responses",
        baseUrl: "https://models.example.com/v1",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
        mediaInput: {
          image: { maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
        },
      },
    });

    const cfg = makeProviderConfig("custom", {
      baseUrl: "https://models.example.com/v1",
      models: [
        { id: "vision-model", name: "Vision Model", mediaInput: { image: { maxBytes: 1 } } },
      ],
    });
    const result = await resolveModelForTest("custom", "vision-model", cfg);

    expect((expectResolvedModel(result) as { mediaInput?: unknown }).mediaInput).toEqual({
      image: { maxBytes: 1, maxSidePx: 2048, preferredSidePx: 1536, tokenMode: "provider" },
    });
  });

  it("defaults model input to text when discovery omits input", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "custom",
      modelId: "missing-input",
      templateModel: {
        id: "missing-input",
        name: "missing-input",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://localhost:9999",
        reasoning: false,
        // NOTE: deliberately omit input to simulate buggy/custom catalogs.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    });

    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9999",
      api: "openai-completions",
      models: [{ id: "missing-input", name: "missing-input" }],
    });
    const result = await resolveModelForTest("custom", "missing-input", cfg);

    expect(expectResolvedModel(result).input).toEqual(["text"]);
  });

  it("does not inherit an unrelated configured row's maxTokens for an unlisted fallback model", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      models: [{ id: "listed-model", name: "listed-model", contextWindow: 32_768, maxTokens: 128 }],
    });

    const result = await resolveModelForTest("custom", "missing-model", cfg);
    const model = expectResolvedModel(result);

    expect(model.id).toBe("missing-model");
    expect(model.maxTokens).toBeUndefined();
    expect(model).not.toHaveProperty("maxTokensSource");
  });

  it("clamps per-model maxTokens to the per-model context window", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(makeXiaomiCatalogModel());
    const cfg = makeProviderConfig("xiaomi-token-plan", {
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      api: "openai-completions",
      models: [
        {
          id: "mimo-v2.5-pro",
          name: "Xiaomi MiMo V2.5 Pro",
          contextWindow: 16_000,
          maxTokens: 32_000,
        },
      ],
    });

    const result = await resolveModelForTest("xiaomi-token-plan", "mimo-v2.5-pro", cfg);
    const model = expectResolvedModel(result);

    expect(model.name).toBe("Xiaomi MiMo V2.5 Pro");
    expect(model.baseUrl).toBe("https://token-plan-sgp.xiaomimimo.com/v1");
    expect(model.contextWindow).toBe(16_000);
    expect(model.maxTokens).toBe(16_000);
    expectRecordFields(model, { maxTokensSource: "configured" });
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "xiaomi-token-plan",
      modelId: "mimo-v2.5-pro",
      cfg,
      workspaceDir: expect.any(String),
      includeRuntimeDiscovery: true,
    });
  });

  it("leaves maxTokens undefined when no configured or catalog value is available (regression: #98295)", async () => {
    // Strict providers reject synthesized caps above their own completion-token ceiling.
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(undefined);
    const cfg = makeProviderConfig("xiaomi", {
      baseUrl: "https://api.xiaomimimo.com/v1",
      models: [{ id: "mimo-v2.5-pro", name: "mimo-v2.5-pro" }],
    });

    const result = await resolveModelForTest("xiaomi", "mimo-v2.5-pro", cfg);
    const model = expectResolvedModel(result);

    expect(model.id).toBe("mimo-v2.5-pro");
    expect(model.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(model.maxTokens).toBeUndefined();
  });

  it("inherits bundled static transport for configured provider fallback models", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeDeepSeekCatalogModel({ compat: deepSeekCatalogCompat }),
    );
    const cfg = makeDeepSeekConfig({ compat: { supportsReasoningEffort: false } }, { baseUrl: "" });

    const result = await resolveModelForTest("deepseek", "deepseek-v4-pro", cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      name: "Custom DeepSeek V4 Pro",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toEqual(
      expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      }),
    );
    expect(resolveBundledStaticCatalogModelMock).toHaveBeenCalledWith({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      cfg,
      workspaceDir: expect.any(String),
      includeRuntimeDiscovery: true,
    });
  });

  it("fills missing configured provider runtime transport from bundled static metadata", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeDeepSeekCatalogModel({ compat: deepSeekCatalogCompat }),
    );
    const cfg = makeDeepSeekConfig({ thinkingLevelMap: { off: null } });
    const baseRuntimeHooks = createRuntimeHooks();
    const runProviderDynamicModel = vi.fn(() => ({
      provider: "deepseek",
      ...makeConfiguredDeepSeekModel(),
    }));

    const result = await resolveModelAsync("deepseek", "deepseek-v4-pro", state.agentDir(), cfg, {
      runtimeHooks: {
        ...baseRuntimeHooks,
        runProviderDynamicModel,
      },
      skipAgentDiscovery: true,
    });
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      reasoning: false,
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.compat).toEqual(
      expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      }),
    );
    expect(runProviderDynamicModel).toHaveBeenCalled();
  });

  it("keeps bundled static baseUrl when provider api is configured without a baseUrl", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeDeepSeekCatalogModel({ api: "openai-responses" }),
    );
    const cfg = makeDeepSeekConfig(
      { thinkingLevelMap: { off: null } },
      { api: "openai-completions" },
    );

    const result = await resolveModelForTest("deepseek", "deepseek-v4-pro", cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 32_768,
      maxTokens: 4_096,
    });
    expect(model.thinkingLevelMap).toEqual({ off: null });
  });

  it("keeps per-model token overrides ahead of bundled static fallback metadata", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeXiaomiCatalogModel({ contextTokens: 500_000 }),
    );
    const cfg = makeProviderConfig("xiaomi-token-plan", {
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      api: "openai-completions",
      maxTokens: 512,
      models: [
        {
          id: "mimo-v2.5-pro",
          name: "Xiaomi MiMo V2.5 Pro",
          contextWindow: 100_000,
          contextTokens: 90_000,
        },
      ],
    });

    const result = await resolveModelForTest("xiaomi-token-plan", "mimo-v2.5-pro", cfg);
    const model = expectResolvedModel(result);

    expectRecordFields(model, {
      contextWindow: 100_000,
      contextTokens: 90_000,
      maxTokens: 512,
    });
  });

  it("does not create fallback models from provider overlays alone", async () => {
    const cfg = {
      models: {
        providers: {
          typoProvider: {
            timeoutSeconds: 600,
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = await resolveModelForTest(
      "typoProvider",
      "typoed-model",
      makeOpenClawConfigFixture(cfg),
    );

    expectUnknownModelErrorResult(result, "typoProvider", "typoed-model");
  });

  it("keeps exact configured routes ahead of earlier legacy rows", async () => {
    const exact = { ...makeModel("Model"), baseUrl: "https://exact.example.test/v1" };
    const legacy = {
      ...makeModel("custom/Model"),
      baseUrl: "https://legacy.example.test/v1",
      headers: { "x-route": "legacy" },
    };
    const cfg = makeProviderConfig("custom", {
      api: "openai-completions",
      baseUrl: "https://provider.example.test/v1",
      models: [legacy, exact],
    });
    for (const row of [exact, legacy]) {
      const resolved = await resolveModelWithRegistry({
        provider: "custom",
        modelId: row.id,
        cfg,
        modelRegistry: createEmptyAgentDiscoveryStores().modelRegistry,
        agentDir: state.agentDir(),
        runtimeHooks: createRuntimeHooks(),
      });
      expect.soft(resolved?.id).toBe(row.id);
      expect.soft(resolved?.baseUrl).toBe(row.baseUrl);
      expect.soft(resolved?.headers).toEqual(row === legacy ? legacy.headers : undefined);
    }
  });

  it.each([false, true])(
    "merges exact rows before provider defaults (empty headers=%s)",
    async (emptyHeaders) => {
      const cfg = makeProviderConfig("custom", {
        api: "anthropic-messages",
        baseUrl: "https://provider.example.test/v1",
        models: [
          { ...makeModel("Model"), ...(emptyHeaders ? { headers: {} } : {}) },
          {
            ...makeModel(" Model "),
            api: "openai-completions",
            baseUrl: "https://duplicate.example.test/v1",
            headers: { "x-route": "duplicate" },
          },
        ],
      });
      const resolved = await resolveModelWithRegistry({
        provider: "custom",
        modelId: "Model",
        cfg,
        modelRegistry: createEmptyAgentDiscoveryStores().modelRegistry,
        agentDir: state.agentDir(),
        runtimeHooks: createRuntimeHooks(),
      });
      expect.soft(resolved).toMatchObject({
        id: "Model",
        api: "openai-completions",
        baseUrl: "https://duplicate.example.test/v1",
      });
      expect.soft(resolved?.headers).toEqual(emptyHeaders ? undefined : { "x-route": "duplicate" });
    },
  );

  it("preserves normalized inline provider transport when static metadata is merged", async () => {
    const cfg = makeProviderConfig("my-gemini", {
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      models: [
        {
          id: "gemini-pro",
          name: "Gemini Pro",
          input: ["text"],
          contextWindow: 32_768,
        },
      ],
    });

    const result = await resolveModelForTest("my-gemini", "gemini-pro", cfg);
    const model = expectResolvedModel(result);

    expect(model.api).toBe("google-generative-ai");
    expect(model.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("resolves explicitly configured qwen3.6-plus before Coding Plan built-in suppression", async () => {
    const cfg = makeProviderConfig("qwen", {
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      api: "openai-completions",
      models: [
        {
          id: "qwen3.6-plus",
          name: "qwen3.6-plus",
          input: ["text", "image"],
          reasoning: false,
          contextWindow: 1_000_000,
          maxTokens: 65_536,
        },
      ],
    });

    const result = await resolveModelForTest("qwen", "qwen3.6-plus", cfg);

    expectRecordFields(expectResolvedModel(result), {
      provider: "qwen",
      id: "qwen3.6-plus",
      api: "openai-completions",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
  });

  it("keeps unconfigured qwen3.6-plus suppressed on Coding Plan endpoints", async () => {
    const cfg = makeProviderConfig("qwen", {
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      api: "openai-completions",
    });

    const result = await resolveModelForTest("qwen", "qwen3.6-plus", cfg);

    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: qwen/qwen3.6-plus. qwen3.6-plus is not supported on the Qwen Coding Plan endpoint; use a Standard pay-as-you-go Qwen endpoint or choose qwen/qwen3.5-plus.",
    );
  });

  it("drops SecretRef marker provider headers in fallback models", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      headers: {
        Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
        "X-Managed": "secretref-managed",
        "X-Custom-Auth": "token-123",
      },
      models: [makeModel("listed-model")],
    });

    const result = await resolveModelForTest("custom", "missing-model", cfg);
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      "X-Custom-Auth": "token-123",
    });
  });

  it("drops marker headers from discovered models.json entries", async () => {
    mockMinimalModelDiscovery("custom", "listed-model", {
      headers: {
        Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
        "X-Managed": "secretref-managed",
        "X-Static": "tenant-a",
      },
    });

    const result = await resolveModelForTest("custom", "listed-model");
    const model = expectResolvedModel(result) as unknown as { headers?: Record<string, string> };

    expect(model.headers).toEqual({
      "X-Static": "tenant-a",
    });
  });

  it("merges configured model params with agent defaults for resolved models", async () => {
    mockMinimalModelDiscovery("ollama", "qwen3:32b", {
      params: { num_ctx: 4096, keep_alive: "1m" },
    });
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          models: {
            "OLLAMA/qwen3:32B": {
              params: { num_ctx: 8192, thinking: "low" },
            },
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://localhost:11434",
            models: [
              {
                ...makeModel("qwen3:32b"),
                params: { num_ctx: 16384 },
              },
            ],
          },
        },
      },
    });

    const result = await resolveModelForTest("ollama", "qwen3:32b", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      num_ctx: 16384,
      keep_alive: "1m",
      thinking: "low",
    });
  });

  it("caps oversized provider request timeout metadata at the timer-safe ceiling", async () => {
    mockMinimalModelDiscovery("openai", "gpt-5.5");
    const cfg = {
      models: {
        providers: {
          openai: {
            timeoutSeconds: Number.MAX_SAFE_INTEGER,
          },
        },
      },
    } satisfies OpenClawConfigInput;

    const result = await resolveModelForTest("openai", "gpt-5.5", makeOpenClawConfigFixture(cfg));

    expect(result.error).toBeUndefined();
    expect((result.model as { requestTimeoutMs?: number } | undefined)?.requestTimeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("applies agent default model params without explicit provider config", async () => {
    mockMinimalModelDiscovery("ollama", "llama3.2");
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          models: {
            "ollama/llama3.2": {
              params: { num_ctx: 32768 },
            },
          },
        },
      },
    });

    const result = await resolveModelForTest("ollama", "llama3.2", cfg);

    expect(result.error).toBeUndefined();
    expect((result.model as { params?: Record<string, unknown> } | undefined)?.params).toEqual({
      num_ctx: 32768,
    });
  });

  it("lets configured vLLM Qwen compat override stale discovered reasoning", async () => {
    mockMinimalModelDiscovery("vllm", "Qwen/Qwen3-8B", {
      api: "openai-completions",
      baseUrl: "http://localhost:9000",
      reasoning: false,
      compat: { supportsStrictMode: false },
    });
    const cfg = makeVllmQwenConfig();

    const result = await resolveModelForTest("vllm", "Qwen/Qwen3-8B", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.reasoning).toBe(true);
    expect(result.model?.compat).toEqual(
      expect.objectContaining({
        supportsStrictMode: false,
        thinkingFormat: "qwen-chat-template",
      }),
    );
  });

  it("does not derive reasoning from ignored compat on a catalog-owned vLLM route", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce({
      ...makeModel("Qwen/Qwen3-8B"),
      provider: "vllm",
      api: "openai-completions",
      baseUrl: "http://localhost:9000",
      reasoning: false,
      compat: { supportsStrictMode: false },
    });
    const cfg = makeVllmQwenConfig();

    const result = await resolveModelForTest("vllm", "Qwen/Qwen3-8B", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.reasoning).toBe(false);
    expect(result.model?.compat).toEqual(expect.objectContaining({ supportsStrictMode: false }));
    expect(result.model?.compat).not.toHaveProperty("thinkingFormat");
  });

  it("infers reasoning for matching vLLM Qwen compat fallback models", async () => {
    const cfg = makeVllmQwenConfig();

    const result = await resolveModelForTest("vllm", "Qwen/Qwen3-8B", cfg);

    expect(result.error).toBeUndefined();
    expect(result.model?.reasoning).toBe(true);
  });

  it("resolves direct moonshotai refs through manifest-owned provider aliases", async () => {
    const cfg = makeProviderConfig("moonshot", {
      baseUrl: "https://api.moonshot.ai/v1",
      api: "openai-completions",
      models: [{ ...makeModel("kimi-k2.6"), name: "Kimi K2.6", input: ["text", "image"] }],
    });

    const result = await resolveModelForTest("moonshotai", "kimi-k2.6", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "moonshot",
      id: "kimi-k2.6",
    });
  });

  it("infers provider-level Azure transport aliases from the configured endpoint", async () => {
    const cfg = makeProviderConfig("azure-openai-responses", {
      baseUrl: "https://example.openai.azure.com/openai/v1",
      models: [],
    });
    resolveBundledStaticCatalogModelMock.mockReturnValue(makeOpenAIStaticModel());

    const result = await resolveModelForTest("azure-openai-responses", "gpt-5.5", cfg, {
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
      skipAgentDiscovery: true,
    });

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "azure-openai-responses",
      id: "gpt-5.5",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
    });
  });

  it.each([false, true])(
    "keeps manifest alias transport ownership (provider config=%s)",
    async (configured) => {
      const cfg = configured
        ? makeProviderConfig("azure-openai-responses", {
            baseUrl: "",
            params: { temperature: 0.2 },
          })
        : undefined;
      resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
        provider: "azure-openai-responses",
        transport: {
          api: "azure-openai-responses",
          baseUrl: "https://manifest-alias.example.com/openai/v1",
        },
      });
      const result = await resolveModelForTest("azure-openai-responses", "gpt-5.5", cfg, {
        allowBundledStaticCatalogFallback: true,
        runtimeHooks: createAzureRuntimeHooks(),
        skipAgentDiscovery: true,
      });
      expect(result.error).toBeUndefined();
      expectRecordFields(result.model, {
        provider: "azure-openai-responses",
        id: "gpt-5.5",
        api: "azure-openai-responses",
        baseUrl: "https://manifest-alias.example.com/openai/v1",
      });
    },
  );

  it("rejects configured fallbacks for ambiguous manifest aliases", async () => {
    resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
      provider: "azure-openai-responses",
      ambiguous: true,
    });
    const cfg = makeProviderConfig("azure-openai-responses", {
      baseUrl: "https://example.openai.azure.com/openai/v1",
      api: "azure-openai-responses",
      models: [makeModel("gpt-5.5")],
    });
    const result = await resolveModelForTest("azure-openai-responses", "gpt-5.5", cfg);
    expectUnknownModelErrorResult(result, "azure-openai-responses", "gpt-5.5");
    expect(resolveBundledStaticCatalogModelMock).not.toHaveBeenCalled();
    expect(resolveBundledProviderStaticCatalogModelMock).not.toHaveBeenCalled();
  });

  it("does not treat arbitrary namespaced model ids as provider prefixes", async () => {
    const cfg = makeProviderConfig("custom", {
      baseUrl: "http://localhost:9000",
      api: "openai-completions",
      models: [
        {
          ...makeModel("meta/vision-model"),
          input: ["text", "image"],
        },
      ],
    });

    const result = await resolveModelForTest("custom", "vision-model", cfg);

    expect(result.model?.id).toBe("vision-model");
    expect(result.model?.input).toEqual(["text"]);
  });

  it("explains when an agent model entry is missing provider model registration", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "microsoft-foundry/Kimi-K2.6-1": {
              contextWindow: 262144,
              maxOutputTokens: 16384,
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await resolveModelAsync(
      "microsoft-foundry",
      "Kimi-K2.6-1",
      state.agentDir(),
      cfg,
      {
        runtimeHooks: createRuntimeHooks(),
        skipAgentDiscovery: true,
      },
    );

    expect(result.error).toBe(
      'Unknown model: microsoft-foundry/Kimi-K2.6-1. Found agents.defaults.models["microsoft-foundry/Kimi-K2.6-1"], but no matching models.providers["microsoft-foundry"].models[] entry. Add { "id": "Kimi-K2.6-1", "name": "Kimi-K2.6-1" } to models.providers["microsoft-foundry"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("suggests running doctor for a legacy openai-codex model entry", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: { "openai-codex/gpt-5.4": {} } } },
    };
    const result = await resolveModelAsync("openai-codex", "gpt-5.4", state.agentDir(), cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });
    expect(result.error).toBe(
      'Unknown model: openai-codex/gpt-5.4. "openai-codex" is a legacy provider ID. Run `openclaw doctor --fix` to migrate legacy model and provider config to the current OpenAI format. If the provider has no authenticated profile, run `openclaw models status` to check provider auth and re-authenticate if needed. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("points runtime-bound model entries at the runtime catalog instead of provider registration", async () => {
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.3-codex": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    });

    const result = await resolveModelAsync("openai", "gpt-5.3-codex", state.agentDir(), cfg, {
      runtimeHooks: createRuntimeHooks(),
      skipAgentDiscovery: true,
    });

    expect(result.error).toBe(
      'Unknown model: openai/gpt-5.3-codex. Found agents.defaults.models["openai/gpt-5.3-codex"] bound to the "codex" agent runtime. Models served by an agent runtime come from that runtime and its linked account, not from models.providers["openai"].models[] — registering it there will not make it usable. Confirm "gpt-5.3-codex" is still offered by the "codex" runtime and switch agents.defaults.model.primary to a currently available model (run `openclaw models list --refresh --provider openai` to list them). See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("repairs stale text-only Foundry discovered rows without config overrides", async () => {
    mockMinimalModelDiscovery("microsoft-foundry", "gpt-5.4", {
      baseUrl: "https://example.services.ai.azure.com/openai/v1",
      api: "azure-openai-responses",
      contextWindow: 128000,
      maxTokens: 16384,
    });

    const result = await resolveModelForTest("microsoft-foundry", "gpt-5.4");

    expect(result.model?.input).toEqual(["text", "image"]);
  });

  it.each(["openrouter/healer-alpha", "google/gemini-3.1-flash-image-preview"])(
    "falls back to text-only for an uncached namespaced OpenRouter model %s",
    async (modelId) => {
      const result = await resolveModelForTest("openrouter", modelId);
      expect(result.error).toBeUndefined();
      expectRecordFields(result.model, {
        provider: "openrouter",
        id: modelId,
        reasoning: false,
        input: ["text"],
      });
    },
  );

  it("uses provider-normalized model ids for OpenRouter transport", async () => {
    const modelId = "openrouter/anthropic/claude-sonnet-4.6";
    mockMinimalModelDiscovery("openrouter", modelId, {
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const normalizeProviderResolvedModelWithPlugin = vi.fn(
      (params: { context: { model: { id: string } } }) => ({
        ...params.context.model,
        id: params.context.model.id.slice("openrouter/".length),
      }),
    );

    const result = await resolveModelAsync("openrouter", modelId, state.agentDir(), undefined, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir()),
      runtimeHooks: {
        ...baseRuntimeHooks,
        normalizeProviderResolvedModelWithPlugin,
      },
    });

    expect(normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        context: expect.objectContaining({
          modelId,
          model: expect.objectContaining({ id: modelId }),
        }),
      }),
    );
    expectRecordFields(result.model, {
      provider: "openrouter",
      id: "anthropic/claude-sonnet-4.6",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });
  });

  it.each([
    {
      label: "exact provider literal",
      exactId: "trinity-large-thinking",
      otherId: "arcee-ai/trinity-large-thinking",
      expectedProvider: "arcee",
    },
    {
      label: "other spelling literal before exact provider equivalent",
      exactId: "arcee-ai/trinity-large-thinking",
      otherId: "trinity-large-thinking",
      expectedProvider: "Arcee",
    },
  ])(
    "preserves provider-spelling lookup order: $label",
    ({ exactId, otherId, expectedProvider }) => {
      const matched = findInlineModelMatch({
        provider: "arcee",
        modelId: "trinity-large-thinking",
        providers: {
          Arcee: {
            api: "openai-completions",
            baseUrl: "https://other.example.test/v1",
            models: [makeModel(otherId)],
          },
          arcee: {
            api: "openai-completions",
            baseUrl: "https://exact.example.test/v1",
            models: [makeModel(exactId)],
          },
        },
      });
      expect.soft(matched?.provider).toBe(expectedProvider);
      expect
        .soft(matched?.baseUrl)
        .toBe(`https://${expectedProvider === "arcee" ? "exact" : "other"}.example.test/v1`);
    },
  );

  it("rejects stale openai gpt-5.3-codex-spark discovery rows", async () => {
    mockMinimalModelDiscovery("openai", "gpt-5.3-codex-spark", {
      ...buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex-spark"),
      name: "GPT-5.3 Codex Spark",
      input: ["text"],
    });
    const result = await resolveModelForTest("openai", "gpt-5.3-codex-spark");
    expect(result.model).toBeUndefined();
    expect(result.error).toBe(
      "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run `openclaw models auth login --provider openai` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.",
    );
  });

  it("builds an openai fallback for gpt-5.4-mini", async () => {
    mockOpenAICodexTemplateModel(discoverModels);
    const result = await resolveModelForTest("openai", "gpt-5.4-mini");
    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      ...buildOpenAICodexForwardCompatExpectation("gpt-5.4-mini"),
      contextWindow: 400_000,
      contextTokens: 272_000,
    });
  });

  it("canonicalizes the legacy openai gpt-5.4-codex alias at runtime", async () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const result = await resolveModelForTest("openai", "gpt-5.4-codex");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
    expect(result.model?.id).toBe("gpt-5.4");
    expect(result.model?.name).toBe("gpt-5.4");
  });

  it("prefers alias-specific overrides over canonical ones for gpt-5.4-codex", async () => {
    mockOpenAICodexTemplateModel(discoverModels);

    const cfg = makeProviderConfig("openai", {
      api: "openai-chatgpt-responses",
      models: [
        {
          ...makeModel("gpt-5.4"),
          contextWindow: 222222,
          maxTokens: 22222,
        },
        {
          ...makeModel("gpt-5.4-codex"),
          contextWindow: 111111,
          maxTokens: 11111,
        },
      ],
    });

    const result = await resolveModelForTest("openai", "gpt-5.4-codex", cfg);

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      contextWindow: 111111,
      maxTokens: 11111,
    });
  });

  it("prefers runtime-resolved openai gpt-5.4 metadata when it has a larger context window", async () => {
    mockMinimalModelDiscovery("openai", "gpt-5.4", {
      ...OPENAI_CODEX_TEMPLATE_MODEL,
      id: "gpt-5.4",
      name: "GPT-5.4",
      contextWindow: 128_000,
      contextTokens: 32_000,
      input: ["text"],
    });

    const result = await resolveModelForTest("openai", "gpt-5.4");

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
  });

  it("passes configured workspaceDir through direct registry dynamic hooks", async () => {
    const runProviderDynamicModel = vi.fn(
      (params: {
        workspaceDir?: string;
        context: { workspaceDir?: string; provider: string; modelId: string };
      }) =>
        params.workspaceDir === state.workspaceDir &&
        params.context.workspaceDir === state.workspaceDir &&
        params.context.provider === "openai" &&
        params.context.modelId === "gpt-5.4"
          ? ({
              ...buildOpenAICodexForwardCompatExpectation("gpt-5.4"),
              name: "GPT-5.4",
            } as ReturnType<typeof buildOpenAICodexForwardCompatExpectation>)
          : undefined,
    );
    const runtimeHooks = {
      ...createRuntimeHooks(),
      runProviderDynamicModel,
    };
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
        },
      },
    } as OpenClawConfig;

    const result = await resolveModelWithRegistry({
      provider: "openai",
      modelId: "gpt-5.4",
      agentDir: state.agentDir("state"),
      cfg,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir("state")),
      runtimeHooks,
    });

    const dynamicInput = mockCallArg(runProviderDynamicModel);
    expectRecordFields(dynamicInput, {
      workspaceDir: state.workspaceDir,
    });
    expectRecordFields(dynamicInput.context, {
      workspaceDir: state.workspaceDir,
      agentDir: state.agentDir("state"),
      modelId: "gpt-5.4",
      provider: "openai",
    });
    expectRecordFields(result, {
      provider: "openai",
      id: "gpt-5.4",
    });
  });

  it.each(["provider", "model"])(
    "preserves authored %s transport and model overrides",
    async (scope) => {
      const { buildOpenAIProvider } = await loadBundledPluginFacade<{
        buildOpenAIProvider: () => ProviderPlugin;
      }>({ pluginId: "openai", artifactBasename: "api.js" });
      const provider = buildOpenAIProvider();
      const modelId = "gpt-5.6-luna";
      const route = { api: "openai-completions", baseUrl: "https://proxy.example/v1" } as const;
      const providerConfig: ModelProviderConfig = {
        baseUrl: "https://api.openai.com/v1",
        ...(scope === "provider" ? route : {}),
        headers: { "X-Provider-Route": "authored" },
        models: [
          {
            id: modelId,
            name: "Authored Luna",
            ...(scope === "model" ? route : {}),
            headers: { "X-Model-Route": "authored" },
            compat: { codeMode: "capable", supportsTemperature: true },
            reasoning: false,
            input: ["text"],
            contextWindow: 64_000,
            maxTokens: 4_000,
            cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      };
      const config = { models: { providers: { openai: providerConfig } } };
      const discoveredModel = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId,
        providerConfig,
        config,
        modelRegistry: {
          find: () => undefined,
          getAll: () => [],
          getAvailable: () => [],
          hasConfiguredAuth: () => false,
        },
      });
      if (!discoveredModel) {
        throw new Error("expected the OpenAI dynamic model");
      }
      expect(discoveredModel.compat?.codeMode).toBe("preferred");

      const model = applyConfiguredProviderOverrides({
        provider: "openai",
        modelId,
        discoveredModel,
        providerConfig,
        cfg: config,
        manifestAlias: { provider: "openai" },
        runtimeHooks: {
          buildProviderUnknownModelHintWithPlugin: ({ context }) =>
            provider.buildUnknownModelHint?.(context) ?? undefined,
          prepareProviderDynamicModel: async () => undefined,
          runProviderDynamicModel: ({ context }) => provider.resolveDynamicModel?.(context),
          normalizeProviderResolvedModelWithPlugin: ({ context }) =>
            provider.normalizeResolvedModel?.(context),
          normalizeProviderTransportWithPlugin: ({ context }) =>
            provider.normalizeTransport?.(context) ?? undefined,
        },
      });
      expect(model).toMatchObject({
        ...route,
        headers: { "X-Provider-Route": "authored", "X-Model-Route": "authored" },
        compat: { codeMode: "capable", supportsTemperature: true },
        reasoning: false,
        input: ["text"],
        contextWindow: 64_000,
        maxTokens: 4_000,
        cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
      });
    },
  );

  it("normalizes stale native xai completions transport after plugin model normalization", async () => {
    mockDiscoveredModel(discoverModels, {
      provider: "xai",
      modelId: "grok-4.3",
      templateModel: buildForwardCompatTemplate({
        id: "grok-4.3",
        name: "Grok 4.3",
        provider: "xai",
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      }),
    });

    const result = await resolveModelAsync("xai", "grok-4.3-latest", state.agentDir(), undefined, {
      authStorage: { mocked: true } as never,
      modelRegistry: discoverModels({ mocked: true } as never, state.agentDir()),
      runtimeHooks: {
        buildProviderUnknownModelHintWithPlugin: () => undefined,
        prepareProviderDynamicModel: async () => {},
        runProviderDynamicModel: () => undefined,
        applyProviderResolvedTransportWithPlugin: ({ provider, context }) =>
          provider === "xai" &&
          context.model.api === "openai-completions" &&
          context.model.baseUrl === "https://api.x.ai/v1"
            ? {
                ...context.model,
                api: "openai-responses",
              }
            : undefined,
        normalizeProviderResolvedModelWithPlugin: ({ provider, context }) =>
          provider === "xai" ? (context.model as never) : undefined,
        normalizeProviderTransportWithPlugin: () => undefined,
      },
    });

    expect(result.error).toBeUndefined();
    expectRecordFields(result.model, {
      provider: "xai",
      id: "grok-4.3",
      api: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
