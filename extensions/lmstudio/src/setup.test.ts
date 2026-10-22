import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import type {
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
} from "./defaults.js";
import type { LmstudioModelWire } from "./models.js";
import {
  configureLmstudioNonInteractive,
  discoverLmstudioProvider,
  prepareAppGuidedLmstudioSetup,
  promptAndConfigureLmstudioInteractive,
} from "./setup.js";

const fetchLmstudioModelsMock = vi.hoisted(() => vi.fn());
const discoverLmstudioModelsMock = vi.hoisted(() => vi.fn());
const configureSelfHostedNonInteractiveMock = vi.hoisted(() => vi.fn());
const removeProviderAuthProfilesWithLockMock = vi.hoisted(() => vi.fn());
const customHeaders = { Authorization: "Bearer custom-token" };
const proxyHeaders = { "X-Proxy-Auth": "proxy-token" };

vi.mock("./models.fetch.js", () => ({
  fetchLmstudioModels: (...args: unknown[]) => fetchLmstudioModelsMock(...args),
  discoverLmstudioModels: (...args: unknown[]) => discoverLmstudioModelsMock(...args),
  ensureLmstudioModelLoaded: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    removeProviderAuthProfilesWithLock: (...args: unknown[]) =>
      removeProviderAuthProfilesWithLockMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/provider-setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-setup")>();
  return {
    ...actual,
    configureOpenAICompatibleSelfHostedProviderNonInteractive: (...args: unknown[]) =>
      configureSelfHostedNonInteractiveMock(...args),
  };
});

afterAll(() => {
  vi.doUnmock("./models.fetch.js");
  vi.doUnmock("openclaw/plugin-sdk/provider-auth");
  vi.doUnmock("openclaw/plugin-sdk/provider-setup");
  vi.resetModules();
});

function createModel(): ModelDefinitionConfig {
  return {
    id: "qwen3-8b-instruct",
    name: "Qwen3 8B",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 8192,
  };
}

function buildConfig(
  provider: Partial<ModelProviderConfig> = {
    apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
    api: "openai-completions",
  },
  config: Omit<OpenClawConfig, "models"> = {},
): OpenClawConfig {
  return {
    ...config,
    models: {
      providers: {
        lmstudio: { baseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, models: [], ...provider },
      },
    },
  };
}

function createWireModel(
  key: string,
  overrides: Omit<LmstudioModelWire, "key"> = {},
): LmstudioModelWire {
  return {
    type: "llm",
    key,
    loaded_instances: [{ id: `${key}-loaded`, config: { context_length: 32_768 } }],
    ...overrides,
  };
}

function mockFetchedModels(models: LmstudioModelWire[]): void {
  fetchLmstudioModelsMock.mockResolvedValue({ reachable: true, status: 200, models });
}

function mockFetchedModelsOnce(models: LmstudioModelWire[]): void {
  fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: true, status: 200, models });
}

function buildDiscoveryContext(params?: {
  config?: OpenClawConfig;
  apiKey?: string;
  discoveryApiKey?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderCatalogContext {
  return {
    config: params?.config ?? ({} as OpenClawConfig),
    env: params?.env ?? {},
    resolveProviderApiKey: () => ({
      apiKey: params?.apiKey,
      discoveryApiKey: params?.discoveryApiKey,
    }),
    resolveProviderAuth: () => ({
      apiKey: params?.apiKey,
      discoveryApiKey: params?.discoveryApiKey,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

function buildNonInteractiveContext(params?: {
  config?: OpenClawConfig;
  customBaseUrl?: string;
  customApiKey?: string;
  lmstudioApiKey?: string;
  customModelId?: string;
  resolvedApiKey?: string | null;
  resolvedApiKeySource?: "flag" | "env" | "profile";
}) {
  return {
    authChoice: "lmstudio",
    config: params?.config ?? buildConfig(),
    baseConfig: params?.config ?? buildConfig(),
    opts: {
      customBaseUrl: params?.customBaseUrl,
      customApiKey: params?.customApiKey ?? "lmstudio-test-key",
      lmstudioApiKey: params?.lmstudioApiKey,
      customModelId: params?.customModelId,
    } as ProviderAuthMethodNonInteractiveContext["opts"],
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: vi.fn(
      async (_options: Parameters<ProviderAuthMethodNonInteractiveContext["resolveApiKey"]>[0]) =>
        params?.resolvedApiKey === null
          ? null
          : {
              key: params?.resolvedApiKey ?? "lmstudio-test-key",
              source: params?.resolvedApiKeySource ?? "flag",
            },
    ),
    toApiKeyCredential: vi.fn(),
  } satisfies ProviderAuthMethodNonInteractiveContext;
}

async function runNonInteractive(params?: Parameters<typeof buildNonInteractiveContext>[0]) {
  const ctx = buildNonInteractiveContext({
    customBaseUrl: "http://localhost:1234/api/v1/",
    customModelId: "qwen3-8b-instruct",
    ...params,
  });
  return { ctx, result: await configureLmstudioNonInteractive(ctx) };
}

function createPromptText(apiKey = "lmstudio-test-key", baseUrl = "http://localhost:1234/api/v1/") {
  return vi.fn().mockResolvedValueOnce(baseUrl).mockResolvedValueOnce(apiKey);
}

// `promptText` is the public callback-based setup API. Keep its non-wizard
// coverage next to the wizard prompter cases.
function runInteractive(
  params: Omit<Parameters<typeof promptAndConfigureLmstudioInteractive>[0], "config"> & {
    config?: OpenClawConfig;
  } = {},
) {
  const { config = buildConfig(), ...options } = params;
  return promptAndConfigureLmstudioInteractive({
    config,
    ...(options.prompter || options.promptText
      ? options
      : { ...options, promptText: createPromptText() }),
  });
}

function runDiscovery(
  provider: Partial<ModelProviderConfig>,
  context: Omit<NonNullable<Parameters<typeof buildDiscoveryContext>[0]>, "config"> = {},
) {
  return discoverLmstudioProvider(
    buildDiscoveryContext({ config: buildConfig(provider), ...context }),
  );
}

type WizardPromptValues = {
  baseUrl?: string;
  apiKey?: string;
  context?: string;
};

function createQueuedWizardPrompterHarness(
  values: WizardPromptValues = {},
  confirmValues: boolean[] = [],
) {
  return createQueuedWizardPrompter({
    textValues: [
      values.baseUrl ?? "http://localhost:1234/api/v1/",
      values.apiKey ?? "lmstudio-test-key",
      ...(values.context === undefined ? [] : [values.context]),
    ],
    confirmValues,
  });
}

function createMethodBoundWizardPrompterHarness(values: WizardPromptValues = {}): {
  prompter: WizardPrompter;
  note: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
} {
  const { prompter, note, text } = createQueuedWizardPrompterHarness(values);

  class MethodBoundWizardPrompter implements WizardPrompter {
    intro = prompter.intro;
    outro = prompter.outro;
    select = prompter.select;
    multiselect = prompter.multiselect;
    confirm = prompter.confirm;
    progress = prompter.progress;

    async note(message: string, title?: string) {
      await this.recordNote(message, title);
    }
    async text() {
      return await this.readText();
    }
    private async readText(): Promise<string> {
      return (await text()) as string;
    }
    private async recordNote(message: string, title?: string) {
      await note(message, title);
    }
  }

  return { prompter: new MethodBoundWizardPrompter(), note, text };
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label = "LM Studio provider",
) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function expectApiKeyProvider(provider: unknown) {
  expectRecordFields(provider, { auth: "api-key", apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR });
}

function requireNonInteractiveLmstudioProvider(
  result: Awaited<ReturnType<typeof configureLmstudioNonInteractive>>,
): Record<string, unknown> {
  return requireRecord(result?.models?.providers?.lmstudio, "LM Studio provider config");
}

function requireConfigPatchLmstudioProvider(
  result: Awaited<ReturnType<typeof promptAndConfigureLmstudioInteractive>>,
): Record<string, unknown> {
  return requireRecord(
    result.configPatch?.models?.providers?.lmstudio,
    "LM Studio config patch provider",
  );
}

function requireProviderModels(provider: unknown): unknown[] {
  const models = requireRecord(provider, "LM Studio provider").models;
  if (!Array.isArray(models)) {
    throw new Error("expected LM Studio models to be an array");
  }
  return models;
}

function expectModelFields(
  model: unknown,
  expected: Record<string, unknown> = { id: "qwen3-8b-instruct" },
) {
  expectRecordFields(model, expected, "LM Studio model");
}

function expectProfileFields(profile: unknown, key: string) {
  const expectedCredential = { type: "api_key", provider: "lmstudio", key };
  const profileRecord = requireRecord(profile, "LM Studio profile");
  expect(profileRecord.profileId).toBe("lmstudio:default");
  expect(profileRecord.credential).toEqual(expectedCredential);
}

function expectAuthProfilesRemoved() {
  expect(removeProviderAuthProfilesWithLockMock).toHaveBeenCalledWith({
    cfg: expect.any(Object),
    provider: "lmstudio",
    agentDir: undefined,
  });
}

function expectDiscoveryRequest(
  apiKey?: string,
  headers?: Record<string, string>,
  baseUrl = LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
) {
  expect(fetchLmstudioModelsMock).toHaveBeenCalledWith({
    baseUrl,
    apiKey,
    ...(headers ? { headers } : {}),
    timeoutMs: 5000,
  });
}

function expectSingleModel(provider: unknown) {
  const models = requireProviderModels(provider);
  expect(models).toHaveLength(1);
  expectModelFields(models[0]);
}

function loadedToolModel(key: string, context = 32_768): LmstudioModelWire {
  return {
    key,
    max_context_length: 65_536,
    loaded_instances: [{ id: key, config: { context_length: context } }],
  };
}

describe("lmstudio setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    fetchLmstudioModelsMock.mockReset();
    discoverLmstudioModelsMock.mockReset();
    configureSelfHostedNonInteractiveMock.mockReset();
    removeProviderAuthProfilesWithLockMock.mockReset();

    mockFetchedModels([createWireModel("qwen3-8b-instruct")]);
    discoverLmstudioModelsMock.mockResolvedValue([createModel()]);
    configureSelfHostedNonInteractiveMock.mockImplementation(
      async ({
        providerId,
        ctx,
      }: {
        providerId: string;
        ctx: ProviderAuthMethodNonInteractiveContext;
      }) => {
        const modelId =
          (typeof ctx.opts.customModelId === "string" ? ctx.opts.customModelId.trim() : "") ||
          "qwen3-8b-instruct";
        return {
          agents: { defaults: { model: { primary: `${providerId}/${modelId}` } } },
          models: {
            providers: {
              [providerId]: { api: "openai-completions", auth: "api-key", apiKey: "LM_API_TOKEN" },
            },
          },
        };
      },
    );
  });

  it("prepares an existing tool-capable LLM without a credential profile", async () => {
    mockFetchedModels([
      createWireModel("nomic-embed", { type: "embedding" }),
      createWireModel("chat-only", { display_name: "Chat only" }),
      createWireModel("qwen3-8b-instruct", {
        display_name: "Qwen3 8B",
        max_context_length: 65536,
        capabilities: { trained_for_tool_use: true },
      }),
    ]);

    const result = await prepareAppGuidedLmstudioSetup({ config: {}, env: {} });
    expect(result).toMatchObject({ profiles: [], defaultModel: "lmstudio/qwen3-8b-instruct" });
    expect(result?.configPatch?.models?.mode).toBe("merge");
    expect(result?.configPatch?.models?.providers?.lmstudio).toMatchObject({
      baseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
      api: "openai-completions",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      models: [
        expect.objectContaining({ id: "chat-only" }),
        expect.objectContaining({ id: "qwen3-8b-instruct" }),
      ],
    });
    await expect(
      prepareAppGuidedLmstudioSetup({ config: {}, env: {}, modelRef: "lmstudio/chat-only" }),
    ).resolves.toBeNull();
    await expect(
      prepareAppGuidedLmstudioSetup({ config: {}, env: {}, modelRef: "lmstudio/not-installed" }),
    ).resolves.toBeNull();
  });

  it.each([
    {
      name: "prefers the strongest tool-calling family among loaded models",
      models: [
        loadedToolModel("llama3.3-70b-instruct"),
        loadedToolModel("qwen3.5-4b-instruct"),
        loadedToolModel("nomic-embed-text"),
      ],
      expectedModel: "lmstudio/qwen3.5-4b-instruct",
    },
    {
      name: "ignores a preferred downloaded model when another model is loaded",
      models: [
        { key: "qwen3.5-4b-instruct", max_context_length: 65_536, loaded_instances: [] },
        loadedToolModel("llama3.3-70b-instruct"),
      ],
      expectedModel: "lmstudio/llama3.3-70b-instruct",
    },
    {
      name: "skips a preferred model loaded with less than 16k context",
      models: [
        loadedToolModel("llama3.3-70b-instruct"),
        loadedToolModel("qwen3.5-4b-instruct", 8_192),
      ],
      expectedModel: "lmstudio/llama3.3-70b-instruct",
    },
    {
      name: "does not auto-detect a model without measured or advertised context",
      models: [{ key: "qwen3.5-4b-instruct" }],
      expectedModel: undefined,
    },
  ])("$name", async ({ models, expectedModel }) => {
    mockFetchedModels(
      models.map((model) => ({
        type: "llm",
        capabilities: { trained_for_tool_use: true },
        ...model,
      })),
    );

    const result = await prepareAppGuidedLmstudioSetup({ config: {}, env: {} });
    if (expectedModel) {
      expect(result?.defaultModel).toBe(expectedModel);
    } else {
      expect(result).toBeNull();
    }
  });

  it("non-interactive setup selects the preferred discovered model when none is provided", async () => {
    mockFetchedModelsOnce([
      createWireModel("phi-4", { max_context_length: 65536 }),
      createWireModel("qwen3-8b-instruct", { display_name: "Qwen3 8B" }),
    ]);
    const { result } = await runNonInteractive({ customModelId: undefined });

    const setupCall = requireRecord(
      configureSelfHostedNonInteractiveMock.mock.calls[0]?.[0],
      "self-hosted setup call",
    );
    const setupCtx = requireRecord(setupCall.ctx, "self-hosted setup context");
    expectRecordFields(
      setupCtx.opts,
      { customModelId: "qwen3-8b-instruct" },
      "self-hosted setup opts",
    );
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "lmstudio/qwen3-8b-instruct",
    );
    const models = requireProviderModels(requireNonInteractiveLmstudioProvider(result));
    expect(models).toHaveLength(2);
    expectModelFields(models[0], { id: "phi-4", contextWindow: 65536 });
    expectModelFields(models[1]);
  });

  it("non-interactive setup synthesizes lmstudio-local when API key is missing", async () => {
    const { result } = await runNonInteractive({ resolvedApiKey: null });

    expectDiscoveryRequest(LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER);
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    expectSingleModel(provider);
  });

  it.each([
    {
      name: "non-interactive setup keeps Authorization header auth without writing a synthetic key",
      resolvedApiKey: null,
      withProfile: true,
    },
    {
      name: "non-interactive setup clears stale profile auth before switching to Authorization header auth",
      resolvedApiKey: "stale-profile-key",
      resolvedApiKeySource: "profile" as const,
      withProfile: true,
    },
    {
      name: "non-interactive setup clears env fallback auth before switching to Authorization header auth",
      resolvedApiKey: "env-fallback-key",
      resolvedApiKeySource: "env" as const,
      withProfile: false,
    },
  ])("$name", async ({ resolvedApiKey, resolvedApiKeySource, withProfile }) => {
    const headers = { Authorization: "Bearer proxy-token" };
    const { result } = await runNonInteractive({
      config: buildConfig(
        {
          ...(withProfile ? { apiKey: "stale-config-key" } : {}),
          auth: "api-key",
          api: "openai-completions",
          headers,
        },
        withProfile
          ? {
              auth: {
                profiles: { "lmstudio:default": { provider: "lmstudio", mode: "api_key" } },
                order: { lmstudio: ["lmstudio:default"] },
              },
            }
          : {},
      ),
      customApiKey: "",
      resolvedApiKey,
      resolvedApiKeySource,
    });

    expectAuthProfilesRemoved();
    expectDiscoveryRequest(undefined, { Authorization: "Bearer proxy-token" });
    expect(configureSelfHostedNonInteractiveMock).not.toHaveBeenCalled();
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "lmstudio/qwen3-8b-instruct",
    );
    const provider = requireNonInteractiveLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: { Authorization: "Bearer proxy-token" },
    });
    expectSingleModel(provider);
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
    expect(result?.auth).toBeUndefined();
  });

  it.each([
    {
      name: "a stale literal key",
      params: {
        config: buildConfig({
          auth: "api-key",
          apiKey: "stale-config-key",
          api: "openai-completions",
          headers: { Authorization: "Bearer stale-token", "X-Proxy-Auth": "proxy-token" },
        }),
        lmstudioApiKey: "fresh-cli-key",
        resolvedApiKey: "fresh-cli-key",
      },
    },
    {
      name: "a local auth marker",
      params: {
        config: buildConfig({ apiKey: CUSTOM_LOCAL_AUTH_MARKER, api: "openai-completions" }),
      },
    },
  ])("non-interactive setup replaces $name during re-auth", async ({ params }) => {
    const { result } = await runNonInteractive(params);

    const provider = requireNonInteractiveLmstudioProvider(result);
    expectApiKeyProvider(provider);
    expect(provider.apiKey).not.toBe("stale-config-key");
    expect(provider.headers).toEqual(params.config.models?.providers?.lmstudio?.headers);
  });

  it("interactive setup applies an optional preferred context length to all discovered LM Studio models", async () => {
    mockFetchedModelsOnce([
      createWireModel("phi-4", { display_name: "Phi 4", max_context_length: 65536 }),
      createWireModel("qwen3-8b-instruct", { display_name: "Qwen3 8B", max_context_length: 32768 }),
    ]);
    const { prompter, text } = createMethodBoundWizardPrompterHarness({ context: "4096" });

    const result = await runInteractive({ prompter });

    expect(text).toHaveBeenCalledTimes(3);
    const models = requireProviderModels(requireConfigPatchLmstudioProvider(result));
    expect(models).toHaveLength(2);
    expectModelFields(models[0], {
      id: "phi-4",
      contextWindow: 65536,
      contextTokens: 4096,
      maxTokens: 4096,
    });
    expectModelFields(models[1], {
      id: "qwen3-8b-instruct",
      contextWindow: 32768,
      contextTokens: 4096,
      maxTokens: 4096,
    });
  });

  it("interactive setup preserves gateway wizard note binding on discovery failure", async () => {
    fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: false, models: [] });
    const { prompter, note, text } = createMethodBoundWizardPrompterHarness();

    await expect(
      promptAndConfigureLmstudioInteractive({ config: buildConfig(), prompter }),
    ).rejects.toThrow("LM Studio not reachable");

    expect(text).toHaveBeenCalledTimes(2);
    expect(note).toHaveBeenCalledWith(
      "LM Studio could not be reached at http://localhost:1234/v1.\nStart LM Studio (or run lms server start) and re-run setup.",
      "LM Studio",
    );
  });

  it("remote interactive setup retries discovery without asking for context tuning", async () => {
    fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: false, models: [] });
    mockFetchedModelsOnce([
      createWireModel("text-embedding-nomic-embed-text-v1.5", { type: "embedding" }),
    ]);
    fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: true, status: 503, models: [] });
    mockFetchedModelsOnce([createWireModel("qwen3-8b-instruct")]);
    const { prompter, note, text, confirm } = createQueuedWizardPrompterHarness({}, [
      true,
      true,
      true,
    ]);

    const result = await runInteractive({ prompter, isRemote: true });

    expect(note).toHaveBeenCalledWith(
      "LM Studio could not be reached at http://localhost:1234/v1.\nStart LM Studio (or run lms server start), then continue to retry.",
      "LM Studio",
    );
    expect(confirm).toHaveBeenCalledWith({
      message: "Retry this LM Studio connection now?",
      initialValue: true,
    });
    expect(note).toHaveBeenCalledWith(
      "LM Studio returned HTTP 503 while listing models at http://localhost:1234/v1.\nWait for LM Studio to recover, then continue to retry.",
      "LM Studio",
    );
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(text).toHaveBeenCalledTimes(2);
    expect(result.defaultModel).toBe("lmstudio/qwen3-8b-instruct");
  });

  it("remote interactive setup does not retry immutable HTTP failures", async () => {
    fetchLmstudioModelsMock.mockResolvedValueOnce({ reachable: true, status: 401, models: [] });
    const { prompter, note, confirm } = createQueuedWizardPrompterHarness();

    await expect(
      promptAndConfigureLmstudioInteractive({ config: buildConfig(), prompter, isRemote: true }),
    ).rejects.toThrow("LM Studio discovery failed (401)");

    expect(note).toHaveBeenCalledWith(
      "LM Studio returned HTTP 401 while listing models at http://localhost:1234/v1.\nCheck the base URL and API key, then re-run setup.",
      "LM Studio",
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("remote interactive setup stops when cancelled during retry discovery", async () => {
    const controller = new AbortController();
    const retry = createDeferred<{ reachable: true; status: 200; models: never[] }>();
    fetchLmstudioModelsMock
      .mockResolvedValueOnce({ reachable: false, models: [] })
      .mockImplementationOnce(() => retry.promise);
    const { prompter } = createQueuedWizardPrompterHarness({}, [true]);

    const setup = runInteractive({ prompter, isRemote: true, signal: controller.signal });
    await vi.waitFor(() => expect(fetchLmstudioModelsMock).toHaveBeenCalledTimes(2));
    controller.abort();
    retry.resolve({ reachable: true, status: 200, models: [] });

    await expect(setup).rejects.toMatchObject({ name: "AbortError" });
  });

  it("interactive Docker setup defaults to the host LM Studio endpoint", async () => {
    vi.stubEnv("OPENCLAW_DOCKER_SETUP", "1");
    const { prompter, text } = createQueuedWizardPrompterHarness({
      baseUrl: "http://host.docker.internal:1234",
      apiKey: "",
      context: "",
    });

    const result = await runInteractive({ prompter });

    const firstTextCall = requireRecord(text.mock.calls[0]?.[0], "first text prompt");
    expectRecordFields(
      firstTextCall,
      {
        initialValue: "http://host.docker.internal:1234",
        placeholder: "http://host.docker.internal:1234",
      },
      "first text prompt",
    );
    expectDiscoveryRequest(
      LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      undefined,
      "http://host.docker.internal:1234/v1",
    );
    expectRecordFields(requireConfigPatchLmstudioProvider(result), {
      baseUrl: "http://host.docker.internal:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    expect(result.profiles).toStrictEqual([]);
    expect(requireConfigPatchLmstudioProvider(result)).not.toHaveProperty("auth");
    expectAuthProfilesRemoved();
  });

  it("interactive setup uses existing Authorization headers when the API key is blank", async () => {
    const config = buildConfig({
      api: "openai-completions",
      apiKey: "stale-config-key",
      auth: "api-key",
      headers: { Authorization: "Bearer proxy-token" },
    });
    const { prompter } = createQueuedWizardPrompterHarness({ apiKey: "", context: "" });

    const result = await runInteractive({ config, prompter });

    expectDiscoveryRequest(undefined, { Authorization: "Bearer proxy-token" });
    expectAuthProfilesRemoved();
    expect(result.profiles).toStrictEqual([]);
    const provider = requireConfigPatchLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: { Authorization: "Bearer proxy-token" },
    });
    expectSingleModel(provider);
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive setup without a wizard accepts a blank API key for local LM Studio", async () => {
    const result = await runInteractive({ promptText: createPromptText("") });

    expectDiscoveryRequest(LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER);
    expectAuthProfilesRemoved();
    expect(result.profiles).toStrictEqual([]);
    const provider = requireConfigPatchLmstudioProvider(result);
    expectRecordFields(provider, { apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER });
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive setup overwrites existing config apiKey during re-auth", async () => {
    const result = await runInteractive({
      config: buildConfig(
        {
          auth: "api-key",
          apiKey: "stale-config-key",
          api: "openai-completions",
          headers: { Authorization: "Bearer stale-token", "X-Proxy-Auth": "proxy-token" },
        },
        {
          agents: { defaults: { models: { "anthropic/claude-sonnet-4-6": { alias: "Sonnet" } } } },
        },
      ),
      promptText: createPromptText("fresh-prompt-key"),
    });
    expect(result.configPatch?.models?.mode).toBe("merge");
    const provider = requireConfigPatchLmstudioProvider(result);
    expectRecordFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
    });
    expectApiKeyProvider(provider);
    expect(provider.apiKey).not.toBe("stale-config-key");
    expect(result.defaultModel).toBe("lmstudio/qwen3-8b-instruct");
    expectProfileFields(result.profiles[0], "fresh-prompt-key");
    expect(provider.headers).toEqual({
      Authorization: "Bearer stale-token",
      "X-Proxy-Auth": "proxy-token",
    });
    expect(result.configPatch?.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
      "lmstudio/qwen3-8b-instruct": {},
    });
  });

  it("interactive setup returns clear errors for unreachable/http-empty results", async () => {
    const cases: [
      string,
      { reachable: boolean; status?: number; models: LmstudioModelWire[] },
      string,
    ][] = [
      ["unreachable", { reachable: false, models: [] }, "LM Studio not reachable"],
      [
        "http error",
        { reachable: true, status: 401, models: [] },
        "LM Studio discovery failed (401)",
      ],
      [
        "no llm models",
        {
          reachable: true,
          status: 200,
          models: [{ type: "embedding", key: "text-embedding-nomic-embed-text-v1.5" }],
        },
        "No loaded LM Studio models found",
      ],
      [
        "only unloaded llm models",
        {
          reachable: true,
          status: 200,
          models: [createWireModel("qwen3-8b-instruct", { loaded_instances: [] })],
        },
        "No loaded LM Studio models found",
      ],
    ];

    for (const [name, discovery, expectedError] of cases) {
      const promptText = createPromptText("lmstudio-test-key", "http://localhost:1234/v1");
      fetchLmstudioModelsMock.mockResolvedValueOnce(discovery);
      await expect(
        promptAndConfigureLmstudioInteractive({ config: buildConfig(), promptText }),
        name,
      ).rejects.toThrow(expectedError);
    }
  });

  it.each<[string, Partial<ModelProviderConfig>, Partial<ModelProviderConfig>]>([
    [
      "api-key mode",
      { auth: "api-key" },
      { auth: "api-key", apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR },
    ],
    [
      "header auth",
      { apiKey: "stale-legacy-key", headers: customHeaders },
      { headers: customHeaders },
    ],
    [
      "unresolved template with header auth",
      { apiKey: "${LMSTUDIO_API_KEY}", headers: customHeaders },
      { headers: customHeaders },
    ],
    [
      "non-auth headers",
      { headers: proxyHeaders },
      { apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, headers: proxyHeaders },
    ],
  ])(
    "discoverLmstudioProvider short-circuits explicit models with %s",
    async (_name, providerPatch, expectedProviderPatch) => {
      const explicitModels = [createModel()];
      const result = await runDiscovery({
        baseUrl: "http://localhost:1234/api/v1/",
        models: explicitModels,
        ...providerPatch,
      });

      expect(discoverLmstudioModelsMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        provider: {
          baseUrl: "http://localhost:1234/v1",
          api: "openai-completions",
          ...expectedProviderPatch,
          models: explicitModels,
        },
      });
    },
  );

  it("discoverLmstudioProvider uses resolved key/headers and non-quiet discovery", async () => {
    discoverLmstudioModelsMock.mockResolvedValueOnce([createModel()]);

    const result = await runDiscovery(
      {
        api: "openai-completions",
        apiKey: { source: "env", provider: "default", id: "LMSTUDIO_DISCOVERY_TOKEN" },
        headers: {
          "X-Proxy-Auth": { source: "env", provider: "default", id: "LMSTUDIO_PROXY_TOKEN" },
        },
      },
      {
        env: {
          LMSTUDIO_DISCOVERY_TOKEN: "secretref-lmstudio-key",
          LMSTUDIO_PROXY_TOKEN: "proxy-token-from-env",
        },
      },
    );

    expect(discoverLmstudioModelsMock.mock.calls[0]?.[0]).toMatchObject({
      onListedModels: expect.any(Function),
      baseUrl: "http://localhost:1234/v1",
      apiKey: "secretref-lmstudio-key",
      headers: { "X-Proxy-Auth": "proxy-token-from-env" },
      quiet: false,
    });
    expect(result?.provider.models?.map((model) => model.id)).toEqual(["qwen3-8b-instruct"]);
  });

  it.each<{ name: string; providerPatch: Partial<ModelProviderConfig> }>([
    {
      name: "discoverLmstudioProvider returns null for unresolved header refs",
      providerPatch: {
        headers: {
          "X-Proxy-Auth": { source: "env", provider: "default", id: "LMSTUDIO_PROXY_TOKEN" },
        },
      },
    },
    {
      name: "discoverLmstudioProvider returns null for an unresolved apiKey ref",
      providerPatch: {
        apiKey: { source: "env", provider: "default", id: "LMSTUDIO_DISCOVERY_TOKEN" },
      },
    },
  ])("$name", async ({ providerPatch }) => {
    const result = await runDiscovery({ api: "openai-completions", ...providerPatch }, { env: {} });

    expect(result).toBeNull();
    expect(discoverLmstudioModelsMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "discoverLmstudioProvider uses configured direct apiKey for discovery",
      configuredApiKey: "configured-direct-key",
      expectedApiKey: "configured-direct-key",
    },
    {
      name: "discoverLmstudioProvider prefers resolved discoveryApiKey over configured apiKey",
      configuredApiKey: "configured-direct-key",
      discoveryApiKey: "resolved-discovery-key",
      expectedApiKey: "resolved-discovery-key",
    },
    {
      name: "discoverLmstudioProvider ignores an unresolved apiKey template when discoveryApiKey is resolved",
      configuredApiKey: "${LMSTUDIO_API_KEY}",
      discoveryApiKey: "resolved-discovery-key",
      expectedApiKey: "resolved-discovery-key",
    },
    {
      name: "discoverLmstudioProvider suppresses stale discovery apiKey when Authorization header auth is configured",
      configuredApiKey: "configured-direct-key",
      discoveryApiKey: "resolved-stale-key",
      headers: { Authorization: "Bearer custom-token" },
      expectedApiKey: "",
    },
  ])("$name", async ({ configuredApiKey, discoveryApiKey, headers, expectedApiKey }) => {
    discoverLmstudioModelsMock.mockResolvedValueOnce([createModel()]);

    const result = await runDiscovery(
      { api: "openai-completions", apiKey: configuredApiKey, ...(headers ? { headers } : {}) },
      { discoveryApiKey, env: {} },
    );

    expect(discoverLmstudioModelsMock.mock.calls[0]?.[0]).toMatchObject({
      onListedModels: expect.any(Function),
      baseUrl: "http://localhost:1234/v1",
      apiKey: expectedApiKey,
      headers,
      quiet: false,
    });
    if (headers) {
      const provider = requireRecord(result?.provider, "discovered LM Studio provider");
      expectRecordFields(provider, {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        headers,
      });
      expectSingleModel(provider);
      expect(provider.apiKey).toBeUndefined();
      expect(provider.auth).toBeUndefined();
    }
  });
});
