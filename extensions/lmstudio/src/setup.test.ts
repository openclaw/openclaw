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
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/provider-setup";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
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

const fetchModels = vi.hoisted(() => vi.fn());
const discoverModels = vi.hoisted(() => vi.fn());
const configureSelfHosted = vi.hoisted(() => vi.fn());
const removeProfiles = vi.hoisted(() => vi.fn());
const MODEL_ID = "qwen3-8b-instruct";
const MODEL_REF = "lmstudio/qwen3-8b-instruct";
const customHeaders = { Authorization: "Bearer custom-token" };
const proxyHeaders = { "X-Proxy-Auth": "proxy-token" };

vi.mock("./models.fetch.js", () => ({
  fetchLmstudioModels: fetchModels,
  discoverLmstudioModels: discoverModels,
  ensureLmstudioModelLoaded: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    removeProviderAuthProfilesWithLock: removeProfiles,
  };
});

vi.mock("openclaw/plugin-sdk/provider-setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-setup")>();
  return {
    ...actual,
    configureOpenAICompatibleSelfHostedProviderNonInteractive: configureSelfHosted,
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
    id: MODEL_ID,
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
  const lmstudio = { baseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL, models: [], ...provider };
  return { ...config, models: { providers: { lmstudio } } };
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
  fetchModels.mockResolvedValue(listed(models));
}

function mockFetchedModelsOnce(models: LmstudioModelWire[]): void {
  fetchModels.mockResolvedValueOnce(listed(models));
}
function listed(models: LmstudioModelWire[] = [], status = 200) {
  return { reachable: true, status, models };
}

async function runNonInteractive(
  params: {
    config?: OpenClawConfig;
    customBaseUrl?: string;
    customApiKey?: string;
    lmstudioApiKey?: string;
    customModelId?: string;
    resolvedApiKey?: string | null;
    resolvedApiKeySource?: "flag" | "env" | "profile";
  } = {},
) {
  const { config: _config, resolvedApiKey: _key, resolvedApiKeySource: _source, ...flags } = params;
  const config = params.config ?? buildConfig();
  const ctx = {
    authChoice: "lmstudio",
    config,
    baseConfig: config,
    opts: {
      customBaseUrl: "http://localhost:1234/api/v1/",
      customModelId: MODEL_ID,
      ...flags,
      customApiKey: params?.customApiKey ?? "lmstudio-test-key",
      lmstudioApiKey: params?.lmstudioApiKey,
    } as ProviderAuthMethodNonInteractiveContext["opts"],
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: async () =>
      params?.resolvedApiKey === null
        ? null
        : {
            key: params?.resolvedApiKey ?? "lmstudio-test-key",
            source: params?.resolvedApiKeySource ?? "flag",
          },
    toApiKeyCredential: vi.fn(),
  } satisfies ProviderAuthMethodNonInteractiveContext;
  return { ctx, result: await configureLmstudioNonInteractive(ctx) };
}

function createPromptText(apiKey = "lmstudio-test-key", baseUrl = "http://localhost:1234/api/v1/") {
  return vi.fn().mockResolvedValueOnce(baseUrl).mockResolvedValueOnce(apiKey);
}

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
  { discoveryApiKey, env = {} }: { discoveryApiKey?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const auth = { discoveryApiKey, mode: "none" as const, source: "none" as const };
  return discoverLmstudioProvider({
    config: buildConfig(provider),
    env,
    resolveProviderApiKey: () => auth,
    resolveProviderAuth: () => auth,
  });
}

type WizardPromptValues = Partial<Record<"baseUrl" | "apiKey" | "context", string>>;

function wizard(values: WizardPromptValues = {}, confirmValues: boolean[] = []) {
  return createQueuedWizardPrompter({
    textValues: [
      values.baseUrl ?? "http://localhost:1234/api/v1/",
      values.apiKey ?? "lmstudio-test-key",
      ...(values.context === undefined ? [] : [values.context]),
    ],
    confirmValues,
  });
}

function boundWizard(values: WizardPromptValues = {}): {
  prompter: WizardPrompter;
  note: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
} {
  const { prompter, note, text } = wizard(values);

  const bound = {
    ...prompter,
    recordNote: note,
    readText: async () => (await text()) as string,
    async note(message: string, title?: string) {
      await this.recordNote(message, title);
    },
    async text() {
      return await this.readText();
    },
  };
  return { prompter: bound, note, text };
}

function expectFields(value: unknown, expected: Record<string, unknown>) {
  expect(value).toEqual(expect.objectContaining(expected));
}

function expectApiKeyProvider(provider: unknown) {
  expectFields(provider, { auth: "api-key", apiKey: LMSTUDIO_DEFAULT_API_KEY_ENV_VAR });
}

function nonInteractiveProvider(
  result: Awaited<ReturnType<typeof configureLmstudioNonInteractive>>,
) {
  return requireProvider(result?.models?.providers?.lmstudio);
}

function interactiveProvider(
  result: Awaited<ReturnType<typeof promptAndConfigureLmstudioInteractive>>,
) {
  return requireProvider(result.configPatch?.models?.providers?.lmstudio);
}
function requireProvider(provider: ModelProviderConfig | undefined) {
  if (!provider) {
    throw new Error("Expected LM Studio provider");
  }
  return provider;
}

function expectProfileFields(profile: unknown, key: string) {
  expectFields(profile, {
    profileId: "lmstudio:default",
    credential: { type: "api_key", provider: "lmstudio", key },
  });
}

function expectAuthProfilesRemoved() {
  expect(removeProfiles).toHaveBeenCalledWith({
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
  expect(fetchModels).toHaveBeenCalledWith({
    baseUrl,
    apiKey,
    ...(headers ? { headers } : {}),
    timeoutMs: 5000,
  });
}

function expectSingleModel(provider: ModelProviderConfig) {
  expect(provider.models).toMatchObject([{ id: MODEL_ID }]);
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
    fetchModels.mockReset();
    discoverModels.mockReset();
    configureSelfHosted.mockReset();
    removeProfiles.mockReset();

    mockFetchedModels([createWireModel(MODEL_ID)]);
    discoverModels.mockResolvedValue([createModel()]);
    configureSelfHosted.mockImplementation(
      async ({
        providerId,
        ctx,
      }: {
        providerId: string;
        ctx: ProviderAuthMethodNonInteractiveContext;
      }) => {
        const modelId =
          (typeof ctx.opts.customModelId === "string" ? ctx.opts.customModelId.trim() : "") ||
          MODEL_ID;
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
      createWireModel(MODEL_ID, {
        display_name: "Qwen3 8B",
        max_context_length: 65536,
        capabilities: { trained_for_tool_use: true },
      }),
    ]);

    const result = await prepareAppGuidedLmstudioSetup({ config: {}, env: {} });
    expect(result).toMatchObject({ profiles: [], defaultModel: MODEL_REF });
    expect(result?.configPatch?.models?.mode).toBe("merge");
    expect(result?.configPatch?.models?.providers?.lmstudio).toMatchObject({
      baseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
      api: "openai-completions",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      models: [
        expect.objectContaining({ id: "chat-only" }),
        expect.objectContaining({ id: MODEL_ID }),
      ],
    });
    await expect(
      prepareAppGuidedLmstudioSetup({ config: {}, env: {}, modelRef: "lmstudio/chat-only" }),
    ).resolves.toBeNull();
    await expect(
      prepareAppGuidedLmstudioSetup({ config: {}, env: {}, modelRef: "lmstudio/not-installed" }),
    ).resolves.toBeNull();
  });

  const llama = loadedToolModel("llama3.3-70b-instruct");
  const qwen = loadedToolModel("qwen3.5-4b-instruct");
  it.each<[string, LmstudioModelWire[], string | undefined]>([
    [
      "prefers the strongest loaded tool caller",
      [llama, qwen, loadedToolModel("nomic-embed-text")],
      "lmstudio/qwen3.5-4b-instruct",
    ],
    [
      "ignores downloaded-only models",
      [{ ...qwen, loaded_instances: [] }, llama],
      "lmstudio/llama3.3-70b-instruct",
    ],
    [
      "skips loaded context below 16k",
      [llama, loadedToolModel("qwen3.5-4b-instruct", 8_192)],
      "lmstudio/llama3.3-70b-instruct",
    ],
    ["requires measured or advertised context", [{ key: "qwen3.5-4b-instruct" }], undefined],
  ])("app-guided setup %s", async (_name, models, expectedModel) => {
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
      createWireModel(MODEL_ID, { display_name: "Qwen3 8B" }),
    ]);
    const { result } = await runNonInteractive({ customModelId: undefined });

    expect(configureSelfHosted.mock.calls[0]?.[0]).toMatchObject({
      ctx: { opts: { customModelId: MODEL_ID } },
    });
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(MODEL_REF);
    expect(nonInteractiveProvider(result).models).toMatchObject([
      { id: "phi-4", contextWindow: 65536 },
      { id: MODEL_ID },
    ]);
  });

  it("non-interactive setup synthesizes lmstudio-local when API key is missing", async () => {
    const { result } = await runNonInteractive({ resolvedApiKey: null });

    expectDiscoveryRequest(LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER);
    const provider = nonInteractiveProvider(result);
    expectFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    expectSingleModel(provider);
  });

  it.each([
    ["missing key", null, undefined, true],
    ["stale profile", "stale-profile-key", "profile", true],
    ["env fallback", "env-fallback-key", "env", false],
  ] as const)(
    "non-interactive header auth replaces %s",
    async (_name, resolvedApiKey, resolvedApiKeySource, withProfile) => {
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
      expect(configureSelfHosted).not.toHaveBeenCalled();
      expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(MODEL_REF);
      const provider = nonInteractiveProvider(result);
      expectFields(provider, {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        headers: { Authorization: "Bearer proxy-token" },
      });
      expectSingleModel(provider);
      expect(provider).not.toHaveProperty("apiKey");
      expect(provider).not.toHaveProperty("auth");
      expect(result?.auth).toBeUndefined();
    },
  );

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

    const provider = nonInteractiveProvider(result);
    expectApiKeyProvider(provider);
    expect(provider.headers).toEqual(params.config.models?.providers?.lmstudio?.headers);
  });

  it("interactive setup applies an optional preferred context length to all discovered LM Studio models", async () => {
    mockFetchedModelsOnce([
      createWireModel("phi-4", { display_name: "Phi 4", max_context_length: 65536 }),
      createWireModel(MODEL_ID, { display_name: "Qwen3 8B", max_context_length: 32768 }),
    ]);
    const { prompter, text } = boundWizard({ context: "4096" });

    const result = await runInteractive({ prompter });

    expect(text).toHaveBeenCalledTimes(3);
    expect(interactiveProvider(result).models).toMatchObject([
      { id: "phi-4", contextWindow: 65536, contextTokens: 4096, maxTokens: 4096 },
      { id: MODEL_ID, contextWindow: 32768, contextTokens: 4096, maxTokens: 4096 },
    ]);
  });

  it("interactive setup preserves gateway wizard note binding on discovery failure", async () => {
    fetchModels.mockResolvedValueOnce({ reachable: false, models: [] });
    const { prompter, note, text } = boundWizard();

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
    fetchModels.mockResolvedValueOnce({ reachable: false, models: [] });
    mockFetchedModelsOnce([
      createWireModel("text-embedding-nomic-embed-text-v1.5", { type: "embedding" }),
    ]);
    fetchModels.mockResolvedValueOnce({ reachable: true, status: 503, models: [] });
    mockFetchedModelsOnce([createWireModel(MODEL_ID)]);
    const { prompter, note, text, confirm } = wizard({}, [true, true, true]);

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
    expect(result.defaultModel).toBe(MODEL_REF);
  });

  it("remote interactive setup does not retry immutable HTTP failures", async () => {
    fetchModels.mockResolvedValueOnce({ reachable: true, status: 401, models: [] });
    const { prompter, note, confirm } = wizard();

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
    fetchModels
      .mockResolvedValueOnce({ reachable: false, models: [] })
      .mockImplementationOnce(() => retry.promise);
    const { prompter } = wizard({}, [true]);

    const setup = runInteractive({ prompter, isRemote: true, signal: controller.signal });
    await vi.waitFor(() => expect(fetchModels).toHaveBeenCalledTimes(2));
    controller.abort();
    retry.resolve({ reachable: true, status: 200, models: [] });

    await expect(setup).rejects.toMatchObject({ name: "AbortError" });
  });

  it("interactive Docker setup defaults to the host LM Studio endpoint", async () => {
    vi.stubEnv("OPENCLAW_DOCKER_SETUP", "1");
    const { prompter, text } = wizard({
      baseUrl: "http://host.docker.internal:1234",
      apiKey: "",
      context: "",
    });

    const result = await runInteractive({ prompter });

    expectFields(text.mock.calls[0]?.[0], {
      initialValue: "http://host.docker.internal:1234",
      placeholder: "http://host.docker.internal:1234",
    });
    expectDiscoveryRequest(
      LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
      undefined,
      "http://host.docker.internal:1234/v1",
    );
    expectFields(interactiveProvider(result), {
      baseUrl: "http://host.docker.internal:1234/v1",
      apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
    });
    expect(result.profiles).toStrictEqual([]);
    expect(interactiveProvider(result)).not.toHaveProperty("auth");
    expectAuthProfilesRemoved();
  });

  it("interactive setup uses existing Authorization headers when the API key is blank", async () => {
    const config = buildConfig({
      api: "openai-completions",
      apiKey: "stale-config-key",
      auth: "api-key",
      headers: { Authorization: "Bearer proxy-token" },
    });
    const { prompter } = wizard({ apiKey: "", context: "" });

    const result = await runInteractive({ config, prompter });

    expectDiscoveryRequest(undefined, { Authorization: "Bearer proxy-token" });
    expectAuthProfilesRemoved();
    expect(result.profiles).toStrictEqual([]);
    const provider = interactiveProvider(result);
    expectFields(provider, {
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
    const provider = interactiveProvider(result);
    expectFields(provider, { apiKey: LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER });
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
    const provider = interactiveProvider(result);
    expectFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
    });
    expectApiKeyProvider(provider);
    expect(result.defaultModel).toBe(MODEL_REF);
    expectProfileFields(result.profiles[0], "fresh-prompt-key");
    expect(provider.headers).toEqual({
      Authorization: "Bearer stale-token",
      "X-Proxy-Auth": "proxy-token",
    });
    expect(result.configPatch?.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
      [MODEL_REF]: {},
    });
  });

  it("interactive setup returns clear errors for unreachable/http-empty results", async () => {
    const noModels = "No loaded LM Studio models found";
    const cases: [{ reachable: boolean; models: LmstudioModelWire[] }, string][] = [
      [{ reachable: false, models: [] }, "LM Studio not reachable"],
      [listed([], 401), "LM Studio discovery failed (401)"],
      [listed([{ type: "embedding", key: "text-embedding-nomic-embed-text-v1.5" }]), noModels],
      [listed([createWireModel(MODEL_ID, { loaded_instances: [] })]), noModels],
    ];

    for (const [discovery, expectedError] of cases) {
      const promptText = createPromptText("lmstudio-test-key", "http://localhost:1234/v1");
      fetchModels.mockResolvedValueOnce(discovery);
      await expect(
        promptAndConfigureLmstudioInteractive({ config: buildConfig(), promptText }),
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

      expect(discoverModels).not.toHaveBeenCalled();
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
    discoverModels.mockResolvedValueOnce([createModel()]);

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

    expect(discoverModels.mock.calls[0]?.[0]).toMatchObject({
      onListedModels: expect.any(Function),
      baseUrl: "http://localhost:1234/v1",
      apiKey: "secretref-lmstudio-key",
      headers: { "X-Proxy-Auth": "proxy-token-from-env" },
      quiet: false,
    });
    expect(result?.provider.models?.map((model) => model.id)).toEqual([MODEL_ID]);
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
    expect(discoverModels).not.toHaveBeenCalled();
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
    discoverModels.mockResolvedValueOnce([createModel()]);

    const result = await runDiscovery(
      { api: "openai-completions", apiKey: configuredApiKey, ...(headers ? { headers } : {}) },
      { discoveryApiKey, env: {} },
    );

    expect(discoverModels.mock.calls[0]?.[0]).toMatchObject({
      onListedModels: expect.any(Function),
      baseUrl: "http://localhost:1234/v1",
      apiKey: expectedApiKey,
      headers,
      quiet: false,
    });
    if (headers) {
      const provider = requireProvider(result?.provider);
      expectFields(provider, {
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
