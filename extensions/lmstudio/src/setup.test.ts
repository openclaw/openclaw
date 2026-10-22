import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { OpenClawConfig, SecretInput } from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import type {
  ProviderAuthResult,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/provider-setup";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { createTempHomeEnv } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR as authEnv,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER as localKey,
} from "./defaults.js";
import type { LmstudioModelWire } from "./models.js";
import {
  buildLmstudioAuthHeaders,
  resolveLmstudioConfiguredApiKey,
  resolveLmstudioProviderHeaders,
  resolveLmstudioRuntimeApiKey,
} from "./runtime.js";
import {
  configureLmstudioNonInteractive as configureNonInteractive,
  prepareAppGuidedLmstudioSetup as prepareGuided,
  promptAndConfigureLmstudioInteractive as configureInteractive,
} from "./setup.js";

const resolveApiKeyForProviderMock = vi.hoisted(() => vi.fn());
const fetchModels = vi.hoisted(() => vi.fn());
const configureProvider = vi.hoisted(() => vi.fn());
const removeProfiles = vi.hoisted(() => vi.fn());
const customHeaders = { Authorization: "Bearer custom-token" };
const modelId = "qwen3-8b-instruct";
const modelRef = "lmstudio/qwen3-8b-instruct";
const baseUrl = "http://localhost:1234/v1";
const keyAuth = { api: "openai-completions" as const, apiKey: authEnv };

// mock-isolation: setup fixtures control model discovery and loading without HTTP requests.
vi.mock("./models.fetch.js", () => ({
  fetchLmstudioModels: (...args: unknown[]) => fetchModels(...args),
  discoverLmstudioModels: vi.fn(),
  ensureLmstudioModelLoaded: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    resolveApiKeyForProvider: (...args: unknown[]) => resolveApiKeyForProviderMock(...args),
    removeProviderAuthProfilesWithLock: (...args: unknown[]) => removeProfiles(...args),
  };
});

vi.mock("openclaw/plugin-sdk/provider-setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-setup")>();
  return {
    ...actual,
    configureOpenAICompatibleSelfHostedProviderNonInteractive: (...args: unknown[]) =>
      configureProvider(...args),
  };
});

afterAll(() => {
  vi.doUnmock("./models.fetch.js");
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.doUnmock("openclaw/plugin-sdk/provider-setup");
  vi.resetModules();
});

function buildConfig(
  provider: Partial<ModelProviderConfig> = keyAuth,
  config: Omit<OpenClawConfig, "models"> = {},
): OpenClawConfig {
  return {
    ...config,
    ...createModelProviderConfig({ lmstudio: { baseUrl, models: [], ...provider } }),
  };
}

function wireModel(key: string, overrides: Omit<LmstudioModelWire, "key"> = {}): LmstudioModelWire {
  return {
    type: "llm",
    key,
    loaded_instances: [{ id: `${key}-loaded`, config: { context_length: 32_768 } }],
    ...overrides,
  };
}

function listModels(models: LmstudioModelWire[]): void {
  fetchModels.mockResolvedValue({ reachable: true, status: 200, models });
}

function listOnce(models: LmstudioModelWire[]): void {
  fetchModels.mockResolvedValueOnce({ reachable: true, status: 200, models });
}

async function nonInteractive(
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
  const config = params.config ?? buildConfig();
  return await configureNonInteractive({
    authChoice: "lmstudio",
    config,
    baseConfig: config,
    opts: {
      customBaseUrl: params.customBaseUrl ?? "http://localhost:1234/api/v1/",
      customModelId: "customModelId" in params ? params.customModelId : modelId,
      customApiKey: params?.customApiKey ?? "lmstudio-test-key",
      lmstudioApiKey: params?.lmstudioApiKey,
    },
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
  } satisfies ProviderAuthMethodNonInteractiveContext);
}

function promptText(apiKey = "lmstudio-test-key", endpoint = "http://localhost:1234/api/v1/") {
  return vi.fn().mockResolvedValueOnce(endpoint).mockResolvedValueOnce(apiKey);
}

// `promptText` is the public callback-based setup API. Keep its non-wizard
// coverage next to the wizard prompter cases.
function interactive(
  params: Omit<Parameters<typeof configureInteractive>[0], "config"> & {
    config?: OpenClawConfig;
  } = {},
) {
  const { config = buildConfig(), ...options } = params;
  return configureInteractive({
    config,
    ...(options.prompter || options.promptText
      ? options
      : { ...options, promptText: promptText() }),
  });
}

type WizardPromptValues = {
  baseUrl?: string;
  apiKey?: string;
  context?: string;
};

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

function boundWizard(values: WizardPromptValues = {}) {
  const { prompter, note, text } = wizard(values);

  class MethodBoundWizardPrompter implements WizardPrompter {
    intro = prompter.intro;
    outro = prompter.outro;
    select = prompter.select;
    multiselect = prompter.multiselect;
    confirm = prompter.confirm;
    progress = prompter.progress;

    private recordNote = note;
    private readText = text;
    async note(message: string, title?: string) {
      await this.recordNote(message, title);
    }
    async text() {
      return (await this.readText()) as string;
    }
  }

  return { prompter: new MethodBoundWizardPrompter(), note, text };
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectFields(
  value: unknown,
  expected: Record<string, unknown>,
  label = "LM Studio provider",
) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function providerOf(config: OpenClawConfig | ProviderAuthResult["configPatch"] | null | undefined) {
  return requireRecord(config?.models?.providers?.lmstudio, "LM Studio provider");
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
  endpoint = LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
) {
  expect(fetchModels).toHaveBeenCalledWith({
    baseUrl: endpoint,
    apiKey,
    ...(headers ? { headers } : {}),
    timeoutMs: 5000,
  });
}

function expectModels(
  provider: Record<string, unknown>,
  models: Record<string, unknown>[] = [{ id: modelId }],
) {
  expect(provider.models).toEqual(models.map((model) => expect.objectContaining(model)));
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
    configureProvider.mockReset();
    removeProfiles.mockReset();

    listModels([wireModel(modelId)]);
    configureProvider.mockImplementation(
      async ({
        providerId,
        ctx,
      }: {
        providerId: string;
        ctx: ProviderAuthMethodNonInteractiveContext;
      }) => {
        const selectedId =
          (typeof ctx.opts.customModelId === "string" ? ctx.opts.customModelId.trim() : "") ||
          modelId;
        return {
          agents: { defaults: { model: { primary: `${providerId}/${selectedId}` } } },
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
    listModels([
      wireModel("nomic-embed", { type: "embedding" }),
      wireModel("chat-only", { display_name: "Chat only" }),
      wireModel(modelId, {
        display_name: "Qwen3 8B",
        max_context_length: 65536,
        capabilities: { trained_for_tool_use: true },
      }),
    ]);

    const result = await prepareGuided({ config: {}, env: {} });
    expect(result).toMatchObject({ profiles: [], defaultModel: modelRef });
    expect(result?.configPatch?.models?.mode).toBe("merge");
    expect(result?.configPatch?.models?.providers?.lmstudio).toMatchObject({
      baseUrl: LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
      api: "openai-completions",
      apiKey: localKey,
      models: [
        expect.objectContaining({ id: "chat-only" }),
        expect.objectContaining({ id: modelId }),
      ],
    });
    await expect(
      prepareGuided({ config: {}, env: {}, modelRef: "lmstudio/chat-only" }),
    ).resolves.toBeNull();
    await expect(
      prepareGuided({ config: {}, env: {}, modelRef: "lmstudio/not-installed" }),
    ).resolves.toBeNull();
  });

  it.each<[string, LmstudioModelWire[], string | undefined]>([
    [
      "prefers the strongest loaded family",
      [
        loadedToolModel("llama3.3-70b-instruct"),
        loadedToolModel("qwen3.5-4b-instruct"),
        loadedToolModel("nomic-embed-text"),
      ],
      "lmstudio/qwen3.5-4b-instruct",
    ],
    [
      "ignores a preferred downloaded model",
      [
        { key: "qwen3.5-4b-instruct", max_context_length: 65_536, loaded_instances: [] },
        loadedToolModel("llama3.3-70b-instruct"),
      ],
      "lmstudio/llama3.3-70b-instruct",
    ],
    [
      "skips a preferred model below 16k context",
      [loadedToolModel("llama3.3-70b-instruct"), loadedToolModel("qwen3.5-4b-instruct", 8_192)],
      "lmstudio/llama3.3-70b-instruct",
    ],
    ["rejects unmeasured context", [{ key: "qwen3.5-4b-instruct" }], undefined],
  ])("%s", async (_name, models, expectedModel) => {
    listModels(
      models.map((model) => ({
        type: "llm",
        capabilities: { trained_for_tool_use: true },
        ...model,
      })),
    );

    const result = await prepareGuided({ config: {}, env: {} });
    if (expectedModel) {
      expect(result?.defaultModel).toBe(expectedModel);
    } else {
      expect(result).toBeNull();
    }
  });

  it("non-interactive setup selects the preferred discovered model when none is provided", async () => {
    listOnce([
      wireModel("phi-4", { max_context_length: 65536 }),
      wireModel(modelId, { display_name: "Qwen3 8B" }),
    ]);
    const result = await nonInteractive({ customModelId: undefined });

    expect(configureProvider.mock.calls[0]?.[0]).toMatchObject({
      ctx: { opts: { customModelId: modelId } },
    });
    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(modelRef);
    expectModels(providerOf(result), [{ id: "phi-4", contextWindow: 65536 }, { id: modelId }]);
  });

  it("non-interactive setup synthesizes lmstudio-local when API key is missing", async () => {
    const result = await nonInteractive({ resolvedApiKey: null });

    expectDiscoveryRequest(localKey);
    const provider = providerOf(result);
    expectFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: localKey,
    });
    expectModels(provider);
  });

  it.each<[string | null, "profile" | "env" | undefined, boolean]>([
    [null, undefined, true],
    ["stale-profile-key", "profile", true],
    ["env-fallback-key", "env", false],
  ])(
    "non-interactive header auth clears key %s from %s",
    async (resolvedApiKey, resolvedApiKeySource, withProfile) => {
      const headers = customHeaders;
      const result = await nonInteractive({
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
      expectDiscoveryRequest(undefined, headers);
      expect(configureProvider).not.toHaveBeenCalled();
      expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(modelRef);
      const provider = providerOf(result);
      expectFields(provider, {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        headers,
      });
      expectModels(provider);
      expect(provider).not.toHaveProperty("apiKey");
      expect(provider).not.toHaveProperty("auth");
      expect(result?.auth).toBeUndefined();
    },
  );

  it.each<[string, NonNullable<Parameters<typeof nonInteractive>[0]>]>([
    [
      "a stale literal key",
      {
        config: buildConfig({
          auth: "api-key",
          apiKey: "stale-config-key",
          api: "openai-completions",
          headers: { Authorization: "Bearer stale-token", "X-Proxy-Auth": "proxy-token" },
        }),
        lmstudioApiKey: "fresh-cli-key",
        resolvedApiKey: "fresh-cli-key",
      },
    ],
    [
      "a local auth marker",
      {
        config: buildConfig({ apiKey: CUSTOM_LOCAL_AUTH_MARKER, api: "openai-completions" }),
      },
    ],
  ])("non-interactive setup replaces %s during re-auth", async (_name, params) => {
    const result = await nonInteractive(params);

    const provider = providerOf(result);
    expectFields(provider, { auth: "api-key", apiKey: keyAuth.apiKey });
    expect(provider.apiKey).not.toBe("stale-config-key");
    expect(provider.headers).toEqual(params.config?.models?.providers?.lmstudio?.headers);
  });

  it("interactive setup applies an optional preferred context length to all discovered LM Studio models", async () => {
    listOnce([
      wireModel("phi-4", { display_name: "Phi 4", max_context_length: 65536 }),
      wireModel(modelId, { display_name: "Qwen3 8B", max_context_length: 32768 }),
    ]);
    const { prompter, text } = boundWizard({ context: "4096" });

    const result = await interactive({ prompter });

    expect(text).toHaveBeenCalledTimes(3);
    expectModels(providerOf(result.configPatch), [
      { id: "phi-4", contextWindow: 65536, contextTokens: 4096, maxTokens: 4096 },
      { id: modelId, contextWindow: 32768, contextTokens: 4096, maxTokens: 4096 },
    ]);
  });

  it("interactive setup preserves gateway wizard note binding on discovery failure", async () => {
    fetchModels.mockResolvedValueOnce({ reachable: false, models: [] });
    const { prompter, note, text } = boundWizard();

    await expect(configureInteractive({ config: buildConfig(), prompter })).rejects.toThrow(
      "LM Studio not reachable",
    );

    expect(text).toHaveBeenCalledTimes(2);
    expect(note).toHaveBeenCalledWith(
      "LM Studio could not be reached at http://localhost:1234/v1.\nStart LM Studio (or run lms server start) and re-run setup.",
      "LM Studio",
    );
  });

  it("remote interactive setup retries discovery without asking for context tuning", async () => {
    fetchModels.mockResolvedValueOnce({ reachable: false, models: [] });
    listOnce([wireModel("text-embedding-nomic-embed-text-v1.5", { type: "embedding" })]);
    fetchModels.mockResolvedValueOnce({ reachable: true, status: 503, models: [] });
    listOnce([wireModel(modelId)]);
    const { prompter, note, text, confirm } = wizard({}, [true, true, true]);

    const result = await interactive({ prompter, isRemote: true });

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
    expect(result.defaultModel).toBe(modelRef);
  });

  it("remote interactive setup does not retry immutable HTTP failures", async () => {
    fetchModels.mockResolvedValueOnce({ reachable: true, status: 401, models: [] });
    const { prompter, note, confirm } = wizard();

    await expect(
      configureInteractive({ config: buildConfig(), prompter, isRemote: true }),
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

    const setup = interactive({ prompter, isRemote: true, signal: controller.signal });
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

    const result = await interactive({ prompter });

    const firstTextCall = requireRecord(text.mock.calls[0]?.[0], "first text prompt");
    expectFields(
      firstTextCall,
      {
        initialValue: "http://host.docker.internal:1234",
        placeholder: "http://host.docker.internal:1234",
      },
      "first text prompt",
    );
    expectDiscoveryRequest(localKey, undefined, "http://host.docker.internal:1234/v1");
    expectFields(providerOf(result.configPatch), {
      baseUrl: "http://host.docker.internal:1234/v1",
      apiKey: localKey,
    });
    expect(result.profiles).toStrictEqual([]);
    expect(providerOf(result.configPatch)).not.toHaveProperty("auth");
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

    const result = await interactive({ config, prompter });

    expectDiscoveryRequest(undefined, { Authorization: "Bearer proxy-token" });
    expectAuthProfilesRemoved();
    expect(result.profiles).toStrictEqual([]);
    const provider = providerOf(result.configPatch);
    expectFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      headers: { Authorization: "Bearer proxy-token" },
    });
    expectModels(provider);
    expect(provider).not.toHaveProperty("apiKey");
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive setup without a wizard accepts a blank API key for local LM Studio", async () => {
    const result = await interactive({ promptText: promptText("") });

    expectDiscoveryRequest(localKey);
    expectAuthProfilesRemoved();
    expect(result.profiles).toStrictEqual([]);
    const provider = providerOf(result.configPatch);
    expectFields(provider, { apiKey: localKey });
    expect(provider).not.toHaveProperty("auth");
  });

  it("interactive setup overwrites existing config apiKey during re-auth", async () => {
    const result = await interactive({
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
      promptText: promptText("fresh-prompt-key"),
    });
    expect(result.configPatch?.models?.mode).toBe("merge");
    const provider = providerOf(result.configPatch);
    expectFields(provider, {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
    });
    expectFields(provider, { auth: "api-key", apiKey: keyAuth.apiKey });
    expect(provider.apiKey).not.toBe("stale-config-key");
    expect(result.defaultModel).toBe(modelRef);
    expectFields(result.profiles[0], {
      profileId: "lmstudio:default",
      credential: { type: "api_key", provider: "lmstudio", key: "fresh-prompt-key" },
    });
    expect(provider.headers).toEqual({
      Authorization: "Bearer stale-token",
      "X-Proxy-Auth": "proxy-token",
    });
    expect(result.configPatch?.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
      [modelRef]: {},
    });
  });

  it("interactive setup rejects embedding-only and unloaded catalogs", async () => {
    // The bound-wizard tests above retain unreachable and HTTP-error coverage.
    for (const models of [
      [wireModel("nomic-embed", { type: "embedding" })],
      [wireModel(modelId, { loaded_instances: [] })],
    ]) {
      listOnce(models);
      await expect(interactive()).rejects.toThrow("No loaded LM Studio models found");
    }
  });
});

const noKey = new Error(
  'No API key found for provider "lmstudio". Auth store: /tmp/auth-profiles.json.',
);
const runtimeKey = (options?: Partial<ModelProviderConfig>, env?: NodeJS.ProcessEnv) =>
  resolveLmstudioRuntimeApiKey({ config: buildConfig(options ?? {}), env });
const configuredKey = (apiKey: SecretInput, env: NodeJS.ProcessEnv) =>
  resolveLmstudioConfiguredApiKey({ config: buildConfig({ apiKey }), env });
function mockRuntimeKey(
  apiKey: string,
  source = "models.providers.lmstudio (synthetic local key)",
) {
  resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey, source, mode: "api-key" });
}

describe("lmstudio-runtime", () => {
  beforeEach(() => {
    resolveApiKeyForProviderMock.mockReset();
  });

  it("throws when runtime auth resolves to blank and no configured key exists", async () => {
    mockRuntimeKey("   ", "profile:lmstudio:default");
    await expect(runtimeKey({ auth: "api-key" })).rejects.toThrow(
      'or run "openclaw models auth login --provider lmstudio".',
    );
  });

  it("falls back to configured env marker key when profile resolution fails", async () => {
    resolveApiKeyForProviderMock.mockRejectedValueOnce(noKey);
    await expect(
      runtimeKey(
        { auth: "api-key", apiKey: "${LM_API_TOKEN}" },
        { LM_API_TOKEN: "template-lmstudio-key" },
      ),
    ).resolves.toBe("template-lmstudio-key");
  });

  it.each([
    [localKey, { auth: "api-key" as const }],
    [CUSTOM_LOCAL_AUTH_MARKER, undefined],
  ] as const)("accepts synthetic runtime key %s", async (key, config) => {
    mockRuntimeKey(key);
    await expect(runtimeKey(config)).resolves.toBe(key);
  });

  it("allows header-only runtime auth when an api key env template is unset", async () => {
    resolveApiKeyForProviderMock.mockRejectedValueOnce(noKey);
    await expect(
      runtimeKey(
        { apiKey: "${LMSTUDIO_API_KEY}", headers: { Authorization: "Bearer proxy-token" } },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it.each(["profile:lmstudio:default", "env:LM_API_TOKEN", "shell env: LM_API_TOKEN"])(
    "suppresses runtime auth from %s when Authorization is configured",
    async (source) => {
      mockRuntimeKey("stale-key", source);
      await expect(
        runtimeKey({ headers: { Authorization: "Bearer proxy-token" } }),
      ).resolves.toBeUndefined();
    },
  );

  it("throws when explicit api-key mode cannot resolve any key", async () => {
    resolveApiKeyForProviderMock.mockRejectedValue(noKey);
    await expect(runtimeKey({ auth: "api-key" })).rejects.toThrow(/LM Studio API key is required/i);
    await expect(
      resolveLmstudioConfiguredApiKey({ config: buildConfig({ auth: "api-key" }) }),
    ).resolves.toBeUndefined();
  });

  it.each<[string, SecretInput, NodeJS.ProcessEnv, string | undefined]>([
    ["direct env marker", "GOOGLE_API_KEY", { GOOGLE_API_KEY: "direct-env-key" }, "direct-env-key"],
    [
      "no recursive SecretRef resolution",
      { source: "env", provider: "default", id: "LM_API_TOKEN" },
      { LM_API_TOKEN: "GOOGLE_API_KEY", GOOGLE_API_KEY: "nested-env-key" },
      undefined,
    ],
    ["synthetic marker suppressed", CUSTOM_LOCAL_AUTH_MARKER, {}, undefined],
  ])("preserves configured auth semantics: %s", async (_name, apiKey, env, expected) => {
    await expect(configuredKey(apiKey, env)).resolves.toBe(expected);
  });

  it("resolves arbitrary env-template api keys from config", async () => {
    await expect(
      configuredKey("${LMSTUDIO_API_KEY}", { LMSTUDIO_API_KEY: "custom-template-lmstudio-key" }),
    ).resolves.toBe("custom-template-lmstudio-key");
  });

  it.each<SecretInput>([
    "${LMSTUDIO_API_KEY}",
    { source: "env", provider: "default", id: "LMSTUDIO_API_KEY" },
  ])("fails closed for unresolved %j unless explicitly allowed", async (apiKey) => {
    const options = { config: buildConfig({ apiKey }), env: {} };

    await expect(resolveLmstudioConfiguredApiKey(options)).rejects.toThrow(
      'models.providers["lmstudio"].apiKey',
    );
    await expect(
      resolveLmstudioConfiguredApiKey({ ...options, allowUnresolved: true }),
    ).resolves.toBeUndefined();
  });

  it("throws a path-specific error when a SecretRef header cannot be resolved", async () => {
    const headerRef: Record<string, SecretInput> = {
      "X-Proxy-Auth": { source: "env", provider: "default", id: "LMSTUDIO_PROXY_TOKEN" },
    };
    await expect(
      resolveLmstudioProviderHeaders({
        config: buildConfig({ headers: headerRef }),
        env: {},
        headers: headerRef,
      }),
    ).rejects.toThrow(/models\.providers\.lmstudio\.headers\.X-Proxy-Auth/i);
  });

  describe.each(["constructor", "prototype"])("loaded %s header", (headerName) => {
    it.each<[string, string | undefined, string | undefined]>([
      ["${LMSTUDIO_HEADER_TEST_TOKEN}", undefined, undefined],
      ["$${LMSTUDIO_HEADER_TEST_TOKEN}", undefined, "${LMSTUDIO_HEADER_TEST_TOKEN}"],
      ["${LMSTUDIO_HEADER_TEST_TOKEN}", "resolved-header-token", "resolved-header-token"],
    ])("preserves header input %s with env %s", async (input, token, expected) => {
      const home = await createTempHomeEnv("openclaw-lmstudio-header-");
      try {
        const configPath = path.join(home.home, ".openclaw", "openclaw.json");
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("LMSTUDIO_HEADER_TEST_TOKEN", token);
        await fs.writeFile(
          configPath,
          JSON.stringify(buildConfig({ headers: { [headerName]: input } })),
        );
        const config = getRuntimeConfig({
          pin: false,
          skipPluginValidation: true,
          skipShellEnvFallback: true,
        });
        const headers = resolveLmstudioProviderHeaders({
          config,
          env: {},
          headers: config.models?.providers?.lmstudio?.headers,
        });
        if (expected === undefined) {
          await expect(headers).rejects.toThrow(`models.providers.lmstudio.headers.${headerName}`);
        } else {
          expect(buildLmstudioAuthHeaders({ headers: await headers })).toEqual({
            [headerName]: expected,
          });
        }
      } finally {
        vi.unstubAllEnvs();
        await home.restore();
      }
    });
  });

  it("builds auth headers with key precedence and json support", () => {
    expect(buildLmstudioAuthHeaders({})).toBeUndefined();
    expect(buildLmstudioAuthHeaders({ apiKey: "  sk-test  " })).toEqual({
      Authorization: "Bearer sk-test",
    });
    expect(buildLmstudioAuthHeaders({ apiKey: "   " })).toBeUndefined();
    expect(buildLmstudioAuthHeaders({ apiKey: localKey })).toBeUndefined();
    expect(
      buildLmstudioAuthHeaders({
        apiKey: localKey,
        headers: { Authorization: "Bearer proxy-token" },
      }),
    ).toEqual({ Authorization: "Bearer proxy-token" });
    expect(
      buildLmstudioAuthHeaders({
        apiKey: "sk-new",
        json: true,
        headers: { authorization: "Bearer sk-old", "X-Proxy": "proxy-token" },
      }),
    ).toEqual({
      "Content-Type": "application/json",
      "X-Proxy": "proxy-token",
      Authorization: "Bearer sk-new",
    });
  });
});
