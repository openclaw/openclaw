// Broad coverage for embedded runner model resolution behavior.
import fs from "node:fs";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { discoverAuthStorageFacts, discoverModels } from "../agent-model-discovery.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../auth-profiles.js";
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

  return {
    ...actual,
    shouldUnconditionallySuppress: ({ provider, id }: { provider?: string; id?: string }) => {
      if (
        (provider === "openai" || provider === "azure-openai-responses") &&
        id?.trim().toLowerCase() === "gpt-5.3-codex-spark"
      ) {
        return true;
      }
      return false;
    },
    buildSuppressedBuiltInModelError: ({ provider, id }: { provider?: string; id?: string }) => {
      if (
        (provider === "openai" || provider === "azure-openai-responses") &&
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
  const createSnapshot = async (input: {
    agentId?: string;
    agentDir: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
  }) => {
    const workspaceDir = discoveryContext.resolveModelWorkspaceDir(
      input.config,
      input.workspaceDir,
      input.agentId,
    );
    const key = `${input.agentId ?? ""}\u0000${input.agentDir}\u0000${workspaceDir ?? ""}`;
    const current = preparedSnapshotState.snapshots.get(key);
    if (current) {
      return current;
    }
    const { authStorage } = await discovery.discoverAuthStorageFacts(input.agentDir);
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
      if (!preparedSnapshotState.enabled) {
        return undefined;
      }
      const workspaceDir = discoveryContext.resolveModelWorkspaceDir(
        input.config,
        input.workspaceDir,
        input.agentId,
      );
      const key = `${input.agentId ?? ""}\u0000${input.agentDir}\u0000${workspaceDir ?? ""}`;
      return preparedSnapshotState.snapshots.get(key);
    },
    loadPreparedModelRuntimeSnapshot: async (input: Parameters<typeof createSnapshot>[0]) =>
      createSnapshot(input),
  };
});

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorageFacts: vi.fn(() => ({ authStorage: { mocked: true } })),
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
import { expectUnknownModelErrorResult } from "./model.forward-compat.test-support.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeOpenClawConfigFixture,
  makeModel,
  mockDiscoveredModel,
  mockOpenAICodexTemplateModel,
  OPENAI_CODEX_TEMPLATE_MODEL,
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
  vi.mocked(discoverAuthStorageFacts).mockClear();
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

describe("resolveModel", () => {
  registerModelAuthReadTests({
    getAgentDir: () => state.agentDir(),
    getAuthSpy: () => auth.spy,
    createRuntimeHooks,
    makeProviderConfig,
    expectResolvedModel,
    expectRecordFields,
  });

  it("replaces models-add metadata with a preferred prepared model", async () => {
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
          metadataSource: "models-add",
        },
      ],
    });
    const result = await resolveModelAsync("acme", "prepared-model", state.agentDir(), cfg, {
      runtimeHooks: {
        ...createRuntimeHooks(),
        prepareProviderDynamicModel,
        runProviderDynamicModel,
        shouldPreferProviderRuntimeResolvedModel: () => true,
      },
      skipAgentDiscovery: true,
    });

    expectRecordFields(expectResolvedModel(result), {
      name: "Prepared Model",
      api: "openai-responses",
      baseUrl: "https://configured.example/v1",
      contextWindow: 65_536,
    });
    expect(prepareProviderDynamicModel).toHaveBeenCalledTimes(1);
    expect(runProviderDynamicModel).not.toHaveBeenCalled();
  });

  it("reuses inherited auth from one lifecycle generation", async () => {
    const agentDir = state.agentDir("worker");
    const defaultAgentDir = state.agentDir();
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(defaultAgentDir, { recursive: true });
    const cfg = makeOpenClawConfigFixture({
      agents: {
        defaults: { authInheritance: { agentId: "main" } },
        entries: {
          main: { agentDir: defaultAgentDir },
          worker: { agentDir },
        },
      },
    });
    mockMinimalModelDiscovery("openai", "gpt-5.5");

    const options = { agentId: "worker", runtimeHooks: createRuntimeHooks() };
    const first = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, options);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "one" } },
      },
      defaultAgentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );
    const second = await resolveModelAsync("openai", "gpt-5.5", agentDir, cfg, options);

    expectResolvedModel(first);
    expectResolvedModel(second);
    expect(discoverAuthStorageFacts).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("uses the resolved default agent directory and workspace for prepared discovery", async () => {
    const agentDir = state.agentDir("workspace-agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const cfg = makeOpenClawConfigFixture({
      agents: {
        entries: { "workspace-agent": { agentDir, workspace: state.workspaceDir } },
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
    expect(discoverAuthStorageFacts).toHaveBeenCalledTimes(1);
    expect(discoverModels).toHaveBeenCalledTimes(1);
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
    expect(discoverAuthStorageFacts).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it("keeps the prepared auth mode through async provider model resolution", async () => {
    const authProfileId = "openai:prepared";
    auth.spy.mockImplementation(() => {
      throw new Error("Prepared auth mode must not read auth storage");
    });
    const baseRuntimeHooks = createRuntimeHooks();
    const prepareProviderDynamicModel = vi.fn(baseRuntimeHooks.prepareProviderDynamicModel);
    const runProviderDynamicModel = vi.fn((params: { context: { authProfileMode?: string } }) => ({
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
    }));

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
      authProfileId,
      authProfileMode: "api_key",
    });
    expectRecordFields(mockCallArg(runProviderDynamicModel).context, {
      authProfileId,
      authProfileMode: "api_key",
    });
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
    expect(discoverAuthStorageFacts).not.toHaveBeenCalled();
    expect(discoverModels).not.toHaveBeenCalled();
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

  it("merges exact rows before provider defaults while preserving empty headers", async () => {
    const cfg = makeProviderConfig("custom", {
      api: "anthropic-messages",
      baseUrl: "https://provider.example.test/v1",
      models: [
        { ...makeModel("Model"), headers: {} },
        {
          ...makeModel(" Model "),
          api: "openai-completions",
          baseUrl: "https://duplicate.example.test/v1",
          headers: { "x-route": "duplicate" },
        },
      ],
    });
    const { model: resolved } = await resolveModelAsync("custom", "Model", state.agentDir(), cfg, {
      ...createEmptyAgentDiscoveryStores(),
      runtimeHooks: createRuntimeHooks(),
    });
    expect.soft(resolved).toMatchObject({
      id: "Model",
      api: "openai-completions",
      baseUrl: "https://duplicate.example.test/v1",
    });
    expect.soft(resolved?.headers).toEqual(undefined);
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
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
