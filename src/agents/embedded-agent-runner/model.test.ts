import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { discoverAuthStorageFacts, discoverModelsAsync } from "../agent-model-discovery.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../auth-profiles.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../auth-profiles/path-resolve.native.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { registerModelAuthReadTests } from "./model.auth-read.test-support.js";
import {
  createEmptyPreparedModelRuntimeFixture,
  guardModelFixtureAuth,
} from "./model.fixture.test-support.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

let state: OpenClawTestState;
let auth: ReturnType<typeof guardModelFixtureAuth>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "model-resolution" });
  prepareSharedAuthStoreOwnershipForNative(state.env);
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
const loadPreparedModelRuntimeSnapshotMock = vi.hoisted(() => vi.fn());
const resolveManifestModelCatalogProviderAliasMetadataMock = vi.hoisted(() =>
  vi.fn<
    typeof import("./model.manifest-alias.js").resolveManifestModelCatalogProviderAliasMetadata
  >(),
);

// mock-isolation: Model-resolution fixtures own prepared auth snapshots; provider discovery must not add host credentials or registries.
vi.mock("../../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
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
  const suppressed = ({ provider, id }: { provider?: string; id?: string }) =>
    (provider === "openai" || provider === "azure-openai-responses") &&
    id?.trim().toLowerCase() === "gpt-5.3-codex-spark";
  return {
    ...actual,
    shouldUnconditionallySuppress: suppressed,
    buildSuppressedBuiltInModelError: (params: Parameters<typeof suppressed>[0]) => {
      const { provider } = params;
      if (suppressed(params)) {
        return `Unknown model: ${provider}/gpt-5.3-codex-spark. gpt-5.3-codex-spark is available only through ChatGPT/Codex OAuth. Run \`openclaw models auth login --provider openai\` and use openai/gpt-5.3-codex-spark with that OAuth profile; OpenAI API-key auth cannot use this model.`;
      }
      return undefined;
    },
  };
});

// mock-isolation: Fixture snapshot lifetimes exclude process-wide auth publication and runtime owners.
vi.mock("../prepared-model-runtime.js", async () => {
  const { PreparedModelRuntimeOwnerNotPublishedError } =
    await import("../prepared-model-runtime.errors.js");
  return {
    PreparedModelRuntimeOwnerNotPublishedError,
    getPreparedModelRuntimeSnapshot: () => undefined,
    loadPreparedModelRuntimeSnapshot: loadPreparedModelRuntimeSnapshotMock,
  };
});

// mock-isolation: Model resolution fixtures control discovery without loading real credentials or model stores.
vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorageFacts: vi.fn(() => ({ authStorage: { mocked: true } })),
  discoverModelsAsync: vi.fn(async () => ({ find: vi.fn(() => null) })),
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

import type { OpenClawConfig } from "../../config/config.js";
import type { Model } from "../../llm/types.js";
import { getModelProviderLocalService } from "../provider-local-service.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { expectUnknownModelErrorResult } from "./model.forward-compat.test-support.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import type { ProviderRuntimeHooks } from "./model.provider-hooks.js";
import {
  makeOpenClawConfigFixture,
  makeModel,
  mockDiscoveredModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  resetMockDiscoverModels(discoverModelsAsync);
  vi.mocked(discoverModelsAsync).mockClear();
  vi.mocked(discoverAuthStorageFacts).mockClear();
  resolveBundledStaticCatalogModelMock.mockReset();
  resolveBundledProviderStaticCatalogModelMock.mockReset();
  loadPreparedModelRuntimeSnapshotMock.mockReset();
  resolveManifestModelCatalogProviderAliasMetadataMock.mockReset();
  resolveManifestModelCatalogProviderAliasMetadataMock.mockImplementation(({ provider, cfg }) => {
    const transport =
      provider === "azure-openai-responses" && cfg?.models?.providers?.[provider]?.baseUrl
        ? { api: "azure-openai-responses" as const }
        : undefined;
    return {
      provider,
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
  // Fixed stores isolate resolution from auth discovery.
  const agentDir = state.agentDir();
  return await resolveModelAsync(provider, modelId, agentDir, cfg, {
    authStorage: { mocked: true } as never,
    modelRegistry: await discoverModelsAsync({ mocked: true } as never, agentDir),
    ...options,
    runtimeHooks: options?.runtimeHooks ?? createRuntimeHooks(),
  });
}

function resolveWithoutDiscovery(
  provider: string,
  modelId: string,
  cfg?: OpenClawConfig,
  options: Parameters<typeof resolveModelAsync>[4] = {},
) {
  return resolveModelAsync(provider, modelId, state.agentDir(), cfg, {
    skipAgentDiscovery: true,
    runtimeHooks: createRuntimeHooks(),
    ...options,
  });
}

function agentModelConfig(
  models: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"],
) {
  return makeOpenClawConfigFixture({ agents: { defaults: { models } } });
}

type ResolveModelForTestResult = Awaited<ReturnType<typeof resolveModelForTest>>;

function expectResolvedModel(result: ResolveModelForTestResult) {
  expect(result.error).toBeUndefined();
  return expectDefined(result.model, "resolved model");
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  expect(record).toMatchObject(expected);
  return record as Record<string, unknown>;
}

function mockMinimalModelDiscovery(
  provider: string,
  modelId: string,
  overrides: Record<string, unknown> = {},
) {
  mockDiscoveredModel(discoverModelsAsync, {
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
    models: { providers: { [provider]: { models: [], ...overrides } } },
  });
}

function makeOpenAIStaticModel(): Model {
  return makeProviderModelFixture({
    id: "gpt-5.5",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
}

const deepSeekCatalogCompat = {
  supportsUsageInStreaming: true,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens" as const,
};
const deepSeekResolvedFields = {
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
  contextWindow: 32_768,
  maxTokens: 4_096,
};

function makeDeepSeekCatalogModel(overrides: Partial<Model> = {}): Model {
  return makeProviderModelFixture({
    provider: "deepseek",
    id: "deepseek-v4-pro",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    ...overrides,
  });
}

const configuredDeepSeekModel = {
  ...makeModel("deepseek-v4-pro"),
  name: "Custom DeepSeek V4 Pro",
  contextWindow: 32_768,
  maxTokens: 4_096,
};

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
      contextWindow: 65_536,
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
          metadataSource: "models-add",
        },
      ],
    });
    const result = await resolveWithoutDiscovery("acme", "prepared-model", cfg, {
      runtimeHooks: {
        ...createRuntimeHooks(),
        prepareProviderDynamicModel,
        runProviderDynamicModel,
        shouldPreferProviderRuntimeResolvedModel: () => true,
      },
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

  it("uses the resolved default agent directory and workspace for prepared discovery", async () => {
    const agentDir = state.agentDir("workspace-agent");
    const cfg = makeOpenClawConfigFixture({
      agents: { entries: { "workspace-agent": { agentDir, workspace: state.workspaceDir } } },
    });
    loadPreparedModelRuntimeSnapshotMock.mockResolvedValueOnce(
      createEmptyPreparedModelRuntimeFixture({
        agentDir,
        config: cfg,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        createStores: createEmptyAgentDiscoveryStores,
      }),
    );
    const result = await resolveModelAsync("openai", "gpt-5.5", undefined, cfg, {
      runtimeHooks: createRuntimeHooks(),
    });
    expectResolvedModel(result);
    expect(loadPreparedModelRuntimeSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir, workspaceDir: state.workspaceDir, config: cfg }),
    );
  });

  it("resolves static rows with prepared auth and metadata without rediscovery", async () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const authProfileId = "openai:prepared";
    auth.spy.mockImplementation(() => {
      throw new Error("Prepared auth mode must not read auth storage");
    });
    const checkAuth = ({
      context,
    }: Parameters<ProviderRuntimeHooks["runProviderDynamicModel"]>[0]) => {
      expect(context).toMatchObject({ authProfileId, authProfileMode: "api_key" });
      return undefined;
    };
    const prepareProviderDynamicModel = vi.fn(async (params: Parameters<typeof checkAuth>[0]) =>
      checkAuth(params),
    );
    const runProviderDynamicModel = vi.fn(checkAuth);
    const preparedModelRuntime = createEmptyPreparedModelRuntimeFixture({
      agentDir: state.agentDir(),
      config: {},
      metadataSnapshot,
      createStores: createEmptyAgentDiscoveryStores,
    });
    resolveBundledProviderStaticCatalogModelMock.mockResolvedValueOnce(
      makeProviderModelFixture({
        provider: "google",
        id: "gemini-3.1-pro-preview",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      }),
    );

    const result = await resolveWithoutDiscovery("google", "gemini-3.1-pro-preview", undefined, {
      allowBundledStaticCatalogFallback: true,
      preparedModelRuntime,
      authProfileId,
      authProfileMode: "api_key",
      runtimeHooks: {
        ...createRuntimeHooks(),
        prepareProviderDynamicModel,
        runProviderDynamicModel,
      },
    });

    expectRecordFields(expectResolvedModel(result), {
      provider: "google",
      id: "gemini-3.1-pro-preview",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(resolveBundledProviderStaticCatalogModelMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadataSnapshot }),
    );
    expect(prepareProviderDynamicModel).toHaveBeenCalledOnce();
    expect(runProviderDynamicModel).toHaveBeenCalledOnce();
    expect(discoverAuthStorageFacts).not.toHaveBeenCalled();
    expect(discoverModelsAsync).not.toHaveBeenCalled();
  });

  it("applies provider overrides to bundled static catalog rows while skipping agent discovery", async () => {
    resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
      makeProviderModelFixture({
        provider: "mistral",
        id: "mistral-medium-3-5",
        api: "openai-completions",
        baseUrl: "https://api.mistral.ai/v1",
      }),
    );
    const request = { proxy: { mode: "explicit-proxy", url: "http://127.0.0.1:18080" } };
    const localService = { command: "/opt/mistral/start" };
    const cfg = makeProviderConfig("mistral", {
      baseUrl: "https://mistral-proxy.example.com/v1",
      api: "openai-completions",
      headers: {
        "X-Proxy": "static-fast-path",
        Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
        "X-Managed": "secretref-managed",
      },
      request,
      localService,
    });

    const result = await resolveWithoutDiscovery("mistral", "mistral-medium-3-5", cfg, {
      allowBundledStaticCatalogFallback: true,
    });
    const model = expectResolvedModel(result);

    expect(model.baseUrl).toBe("https://mistral-proxy.example.com/v1");
    expect(model.headers).toEqual({ "X-Proxy": "static-fast-path" });
    expect(getModelProviderRequestTransport(model)).toEqual(request);
    expect(getModelProviderLocalService(model)).toEqual(localService);
    expect(discoverAuthStorageFacts).not.toHaveBeenCalled();
    expect(discoverModelsAsync).not.toHaveBeenCalled();
  });

  it.each([
    ["xiaomi", "https://api.xiaomimimo.com/v1", "mimo-v2.5-pro", undefined],
    ["local-custom", "http://127.0.0.1:1234/v1", "local-model", "openai-completions"],
    ["local-ollama", "http://127.0.0.1:11434", "local-model", "ollama"],
  ] as const)(
    "leaves unknown output caps unset for %s (regression: #98295)",
    async (provider, baseUrl, modelId, api) => {
      // Strict providers reject synthesized caps above their own completion-token ceiling.
      resolveBundledStaticCatalogModelMock.mockReturnValueOnce(undefined);
      const cfg = makeProviderConfig(provider, {
        baseUrl,
        ...(api ? { api } : {}),
        models: [{ id: modelId, name: modelId }],
      });

      const result = await resolveModelForTest(provider, modelId, cfg);
      const model = expectResolvedModel(result);

      expect(model).toMatchObject({ id: modelId, baseUrl });
      expect(model.maxTokens).toBeUndefined();
    },
  );

  it.each(["fallback", "api override"] as const)(
    "inherits bundled static transport through %s",
    async (mode) => {
      const apiOverride = mode === "api override";
      resolveBundledStaticCatalogModelMock.mockReturnValueOnce(
        makeDeepSeekCatalogModel(
          apiOverride ? { api: "openai-responses" } : { compat: deepSeekCatalogCompat },
        ),
      );
      const cfg = makeProviderConfig("deepseek", {
        models: [
          {
            ...configuredDeepSeekModel,
            ...(mode === "fallback"
              ? { compat: { supportsReasoningEffort: false } }
              : { thinkingLevelMap: { off: null } }),
          },
        ],
        ...(mode === "fallback" ? { baseUrl: "" } : {}),
        ...(apiOverride ? { api: "openai-completions" } : {}),
      });
      const result = await resolveModelForTest("deepseek", "deepseek-v4-pro", cfg);
      const model = expectResolvedModel(result);
      expect(model).toMatchObject({
        ...deepSeekResolvedFields,
        ...(!apiOverride ? { reasoning: false } : {}),
        ...(mode === "fallback" ? { name: "Custom DeepSeek V4 Pro" } : {}),
      });
      if (apiOverride) {
        expect(model.thinkingLevelMap).toEqual({ off: null });
      } else {
        expect(model.compat).toMatchObject(deepSeekCatalogCompat);
      }
    },
  );

  it("merges configured model params with agent defaults for resolved models", async () => {
    mockMinimalModelDiscovery("ollama", "qwen3:32b", {
      params: { num_ctx: 4096, keep_alive: "1m" },
    });
    const cfg = {
      ...agentModelConfig({ "OLLAMA/qwen3:32B": { params: { num_ctx: 8192, thinking: "low" } } }),
      ...makeProviderConfig("ollama", {
        baseUrl: "http://localhost:11434",
        models: [{ ...makeModel("qwen3:32b"), params: { num_ctx: 16384 } }],
      }),
    };

    expect(
      expectResolvedModel(await resolveModelForTest("ollama", "qwen3:32b", cfg)),
    ).toHaveProperty("params", {
      num_ctx: 16384,
      keep_alive: "1m",
      thinking: "low",
    });
  });

  it("applies agent default model params without explicit provider config", async () => {
    mockMinimalModelDiscovery("ollama", "llama3.2");
    const cfg = agentModelConfig({ "ollama/llama3.2": { params: { num_ctx: 32768 } } });

    const result = await resolveModelForTest("ollama", "llama3.2", cfg);

    expect(expectResolvedModel(result)).toHaveProperty("params", { num_ctx: 32768 });
  });

  it.each(["endpoint", "manifest", "configured manifest"] as const)(
    "keeps Azure transport ownership from %s",
    async (source) => {
      const endpoint = source === "endpoint";
      const cfg = endpoint
        ? makeProviderConfig("azure-openai-responses", {
            baseUrl: "https://example.openai.azure.com/openai/v1",
          })
        : source === "configured manifest"
          ? makeProviderConfig("azure-openai-responses", {
              baseUrl: "",
              params: { temperature: 0.2 },
            })
          : undefined;
      if (endpoint) {
        resolveBundledStaticCatalogModelMock.mockReturnValue(makeOpenAIStaticModel());
      } else {
        resolveManifestModelCatalogProviderAliasMetadataMock.mockReturnValue({
          provider: "azure-openai-responses",
          transport: {
            api: "azure-openai-responses",
            baseUrl: "https://manifest-alias.example.com/openai/v1",
          },
        });
      }
      const result = await resolveModelForTest("azure-openai-responses", "gpt-5.5", cfg, {
        allowBundledStaticCatalogFallback: true,
        skipAgentDiscovery: true,
        ...(endpoint
          ? { preferBundledStaticCatalogTransport: true }
          : {
              runtimeHooks: {
                ...createRuntimeHooks(),
                runProviderDynamicModel: makeOpenAIStaticModel,
              },
            }),
      });
      expectRecordFields(expectResolvedModel(result), {
        provider: "azure-openai-responses",
        id: "gpt-5.5",
        api: "azure-openai-responses",
        baseUrl: endpoint
          ? "https://example.openai.azure.com/openai/v1"
          : "https://manifest-alias.example.com/openai/v1",
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
    const cfg = agentModelConfig({ "microsoft-foundry/Kimi-K2.6-1": {} });

    const result = await resolveWithoutDiscovery("microsoft-foundry", "Kimi-K2.6-1", cfg);

    expect(result.error).toBe(
      'Unknown model: microsoft-foundry/Kimi-K2.6-1. Found agents.defaults.models["microsoft-foundry/Kimi-K2.6-1"], but no matching models.providers["microsoft-foundry"].models[] entry. Add { "id": "Kimi-K2.6-1", "name": "Kimi-K2.6-1" } to models.providers["microsoft-foundry"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("suggests running doctor for a legacy openai-codex model entry", async () => {
    const cfg = agentModelConfig({ "openai-codex/gpt-5.4": {} });
    const result = await resolveWithoutDiscovery("openai-codex", "gpt-5.4", cfg);
    expect(result.error).toBe(
      'Unknown model: openai-codex/gpt-5.4. "openai-codex" is a legacy provider ID. Run `openclaw doctor --fix` to migrate legacy model and provider config to the current OpenAI format. If the provider has no authenticated profile, run `openclaw models status` to check provider auth and re-authenticate if needed. See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("points runtime-bound model entries at the runtime catalog instead of provider registration", async () => {
    const cfg = agentModelConfig({ "openai/gpt-5.3-codex": { agentRuntime: { id: "codex" } } });
    const result = await resolveWithoutDiscovery("openai", "gpt-5.3-codex", cfg);

    expect(result.error).toBe(
      'Unknown model: openai/gpt-5.3-codex. Found agents.defaults.models["openai/gpt-5.3-codex"] bound to the "codex" agent runtime. Models served by an agent runtime come from that runtime and its linked account, not from models.providers["openai"].models[] — registering it there will not make it usable. Confirm "gpt-5.3-codex" is still offered by the "codex" runtime and switch agents.defaults.model.primary to a currently available model (run `openclaw models list --refresh --provider openai` to list them). See https://docs.openclaw.ai/concepts/model-providers.',
    );
  });

  it("repairs stale text-only Foundry discovered rows without config overrides", async () => {
    mockMinimalModelDiscovery("microsoft-foundry", "gpt-5.4", {
      baseUrl: "https://example.services.ai.azure.com/openai/v1",
      api: "azure-openai-responses",
    });

    const result = await resolveModelForTest("microsoft-foundry", "gpt-5.4");

    expect(result.model?.input).toEqual(["text", "image"]);
  });
});
