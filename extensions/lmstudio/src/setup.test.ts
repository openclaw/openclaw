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
  ProviderAuthMethodNonInteractiveContext as SetupContext,
} from "openclaw/plugin-sdk/provider-setup";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR as authEnv,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER as localKey,
} from "./defaults.js";
import type { LmstudioModelWire } from "./models.js";
import {
  buildLmstudioAuthHeaders as authHeaders,
  resolveLmstudioConfiguredApiKey as configuredKey,
  resolveLmstudioProviderHeaders as providerHeaders,
  resolveLmstudioRuntimeApiKey as runtimeKey,
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
const staleHeaders = { Authorization: "Bearer stale-token", "X-Proxy-Auth": "proxy-token" };
const staleAuth = { ...keyAuth, auth: "api-key" as const, apiKey: "stale-config-key" };
const endpoint = "http://localhost:1234/api/v1/";
const llama = "llama3.3-70b-instruct";
const qwen = "qwen3.5-4b-instruct";

// mock-isolation: setup fixtures control model discovery and loading without HTTP requests.
vi.mock("./models.fetch.js", () => ({
  fetchLmstudioModels: fetchModels,
  discoverLmstudioModels: vi.fn(),
  ensureLmstudioModelLoaded: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  removeProviderAuthProfilesWithLock: removeProfiles,
}));

vi.mock("openclaw/plugin-sdk/provider-setup", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/provider-setup")>()),
  configureOpenAICompatibleSelfHostedProviderNonInteractive: configureProvider,
}));

afterAll(() => {
  vi.doUnmock("./models.fetch.js");
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.doUnmock("openclaw/plugin-sdk/provider-setup");
  vi.resetModules();
});

afterEach(() => vi.unstubAllEnvs());

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

type ResolvedKey = { key: string; source: "flag" | "env" | "profile" };
type NonInteractiveOptions = {
  config?: OpenClawConfig;
  opts?: Partial<SetupContext["opts"]>;
  key?: ResolvedKey | null;
};
function nonInteractive({
  config = buildConfig(),
  opts = {},
  key = { key: "lmstudio-test-key", source: "flag" },
}: NonInteractiveOptions = {}) {
  return configureNonInteractive({
    authChoice: "lmstudio",
    config,
    baseConfig: config,
    opts: { customBaseUrl: endpoint, customModelId: modelId, ...opts },
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: async () => key,
    toApiKeyCredential: vi.fn(),
  });
}

function promptText(apiKey = "lmstudio-test-key") {
  return vi.fn().mockResolvedValueOnce(endpoint).mockResolvedValueOnce(apiKey);
}

function interactive(params: Partial<Parameters<typeof configureInteractive>[0]> = {}) {
  return configureInteractive({ config: buildConfig(), promptText: promptText(), ...params });
}

function wizard(textValues = [endpoint, "lmstudio-test-key"], confirmValues: boolean[] = []) {
  const harness = createQueuedWizardPrompter({ textValues, confirmValues });
  return {
    ...harness,
    prompter: {
      ...harness.prompter,
      recordNote: harness.note,
      readText: harness.text,
      async note(message: string, title?: string) {
        await this.recordNote(message, title);
      },
      async text(params: Parameters<typeof harness.prompter.text>[0]) {
        return (await this.readText(params)) as string;
      },
    },
  };
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function providerOf(config: OpenClawConfig | ProviderAuthResult["configPatch"] | null | undefined) {
  return requireRecord(config?.models?.providers?.lmstudio, "LM Studio provider");
}

function expectDiscoveryRequest(apiKey?: string, headers?: Record<string, string>, url = baseUrl) {
  const request = { baseUrl: url, apiKey, ...(headers ? { headers } : {}) };
  expect(fetchModels).toHaveBeenCalledWith(expect.objectContaining(request));
}

function expectKeyless(result: ProviderAuthResult) {
  expect(removeProfiles).toHaveBeenCalledWith(expect.objectContaining({ provider: "lmstudio" }));
  expect(result.profiles).toStrictEqual([]);
  expect(providerOf(result.configPatch)).not.toHaveProperty("auth");
}

describe("lmstudio setup", () => {
  beforeEach(() => {
    fetchModels.mockReset();
    configureProvider.mockReset();
    removeProfiles.mockReset();

    listModels([wireModel(modelId)]);
    configureProvider.mockImplementation(async ({ ctx }: { ctx: SetupContext }) => {
      const selectedId =
        (typeof ctx.opts.customModelId === "string" ? ctx.opts.customModelId.trim() : "") ||
        modelId;
      return {
        ...buildConfig(),
        agents: { defaults: { model: { primary: `lmstudio/${selectedId}` } } },
      };
    });
  });

  const loaded = (key: string, context = 32768) =>
    wireModel(key, {
      max_context_length: 65536,
      capabilities: { trained_for_tool_use: true },
      loaded_instances: [{ id: key, config: { context_length: context } }],
    });
  type GuidedCase = {
    models: LmstudioModelWire[];
    selected?: string;
    requested?: string;
  };
  it.each`
    name            | models                                                                                  | selected     | requested
    ${"rank"}       | ${[loaded(llama), loaded(qwen), loaded("nomic-embed-text")]}                            | ${qwen}      | ${undefined}
    ${"downloaded"} | ${[{ ...loaded(qwen), loaded_instances: [] }, loaded(llama)]}                           | ${llama}     | ${undefined}
    ${"small"}      | ${[loaded(llama), loaded(qwen, 8192)]}                                                  | ${llama}     | ${undefined}
    ${"unmeasured"} | ${[{ ...loaded(qwen), loaded_instances: undefined }]}                                   | ${undefined} | ${undefined}
    ${"filter"}     | ${[wireModel("embed", { type: "embedding" }), wireModel("chat-only"), loaded(modelId)]} | ${modelId}   | ${undefined}
    ${"chat-only"}  | ${[wireModel("chat-only"), loaded(modelId)]}                                            | ${undefined} | ${"chat-only"}
    ${"missing"}    | ${[loaded(modelId)]}                                                                    | ${undefined} | ${"not-installed"}
  `("guided setup: $name", async ({ models, selected, requested }: GuidedCase) => {
    listModels(models);
    const result = await prepareGuided({
      config: {},
      env: {},
      ...(requested ? { modelRef: `lmstudio/${requested}` } : {}),
    });
    if (!selected) {
      expect(result).toBeNull();
    } else {
      expect(result).toMatchObject({ profiles: [], defaultModel: `lmstudio/${selected}` });
      expect(result?.configPatch?.models?.mode).toBe("merge");
      expect(providerOf(result?.configPatch)).toMatchObject({ apiKey: localKey });
      expect(providerOf(result?.configPatch).models).toHaveLength(
        models.filter(({ type }) => type !== "embedding").length,
      );
    }
  });

  const storedAuth: OpenClawConfig = {
    auth: {
      profiles: { "lmstudio:default": { provider: "lmstudio", mode: "api_key" } },
      order: { lmstudio: ["lmstudio:default"] },
    },
  };
  function headerOptions(source: "profile" | "env" | null): NonInteractiveOptions {
    const provider = source === "env" ? { ...staleAuth, apiKey: undefined } : staleAuth;
    return {
      config: buildConfig(
        { ...provider, headers: customHeaders },
        source === "env" ? {} : storedAuth,
      ),
      opts: { customApiKey: "" },
      key: source === null ? null : { key: "stale-key", source },
    };
  }
  type SetupCase = {
    options: NonInteractiveOptions;
    expected: Partial<ModelProviderConfig>;
    headerOnly?: boolean;
    models?: LmstudioModelWire[];
  };
  const discovery = [wireModel("phi-4", { max_context_length: 65536 }), wireModel(modelId)];
  const freshOptions = {
    config: buildConfig({ ...staleAuth, headers: staleHeaders }),
    opts: { lmstudioApiKey: "fresh-cli-key" },
    key: { key: "fresh-cli-key", source: "flag" as const },
  };
  it.each`
    name           | options                                                                      | expected                                                       | headerOnly | models
    ${"preferred"} | ${{ opts: { customModelId: undefined } }}                                    | ${keyAuth}                                                     | ${false}   | ${discovery}
    ${"keyless"}   | ${{ key: null }}                                                             | ${{ apiKey: localKey }}                                        | ${false}   | ${undefined}
    ${"missing"}   | ${headerOptions(null)}                                                       | ${{ headers: customHeaders }}                                  | ${true}    | ${undefined}
    ${"profile"}   | ${headerOptions("profile")}                                                  | ${{ headers: customHeaders }}                                  | ${true}    | ${undefined}
    ${"env"}       | ${headerOptions("env")}                                                      | ${{ headers: customHeaders }}                                  | ${true}    | ${undefined}
    ${"stale"}     | ${freshOptions}                                                              | ${{ auth: "api-key", apiKey: authEnv, headers: staleHeaders }} | ${false}   | ${undefined}
    ${"marker"}    | ${{ config: buildConfig({ ...keyAuth, apiKey: CUSTOM_LOCAL_AUTH_MARKER }) }} | ${{ auth: "api-key", apiKey: authEnv }}                        | ${false}   | ${undefined}
  `(
    "non-interactive setup: $name",
    async ({ options, expected, headerOnly, models }: SetupCase) => {
      if (models) {
        listModels(models);
      }
      const result = await nonInteractive(options);
      expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(modelRef);
      const provider = providerOf(result);
      expect(provider).toEqual(
        expect.objectContaining({ baseUrl, api: "openai-completions", ...expected }),
      );
      expect(provider.models).toMatchObject(
        models ? [{ id: "phi-4", contextWindow: 65536 }, { id: modelId }] : [{ id: modelId }],
      );
      if (headerOnly) {
        expectDiscoveryRequest(undefined, customHeaders);
        expect(removeProfiles).toHaveBeenCalledWith(
          expect.objectContaining({ provider: "lmstudio" }),
        );
        expect(provider).not.toHaveProperty("apiKey");
        expect(provider).not.toHaveProperty("auth");
        expect(result?.auth).toBeUndefined();
      } else {
        expectDiscoveryRequest(
          options.key === null ? localKey : (options.key?.key ?? "lmstudio-test-key"),
        );
        expect(provider.headers).toEqual(expected.headers);
      }
    },
  );

  it("interactive setup applies an optional preferred context length to all discovered LM Studio models", async () => {
    listOnce([
      wireModel("phi-4", { max_context_length: 65536 }),
      wireModel(modelId, { max_context_length: 32768 }),
    ]);
    const { prompter } = wizard([endpoint, "lmstudio-test-key", "4096"]);

    const result = await interactive({ prompter });

    expect(providerOf(result.configPatch).models).toMatchObject([
      { id: "phi-4", contextWindow: 65536, contextTokens: 4096, maxTokens: 4096 },
      { id: modelId, contextWindow: 32768, contextTokens: 4096, maxTokens: 4096 },
    ]);
  });

  type DiscoveryFailure = { remote: boolean; status?: number; reason: string; guidance: string };
  it.each`
    remote   | status       | reason                                | guidance
    ${false} | ${undefined} | ${"LM Studio not reachable"}          | ${"Start LM Studio"}
    ${true}  | ${401}       | ${"LM Studio discovery failed (401)"} | ${"Check the base URL and API key"}
  `(
    "reports discovery failure: $reason",
    async ({ remote, status, reason, guidance }: DiscoveryFailure) => {
      fetchModels.mockResolvedValueOnce({ reachable: remote, status, models: [] });
      const { prompter, note } = wizard();
      await expect(interactive({ prompter, isRemote: remote })).rejects.toThrow(reason);
      expect(note).toHaveBeenCalledWith(expect.stringContaining(guidance), "LM Studio");
      expect(prompter.confirm).not.toHaveBeenCalled();
    },
  );

  it("retries transient remote failures without asking for context tuning", async () => {
    fetchModels
      .mockResolvedValueOnce({ reachable: false, models: [] })
      .mockResolvedValueOnce({
        reachable: true,
        models: [wireModel("embed", { type: "embedding" })],
      })
      .mockResolvedValueOnce({ reachable: true, status: 503, models: [] });
    const { prompter, note, text, confirm } = wizard(undefined, [true, true, true]);
    expect((await interactive({ prompter, isRemote: true })).defaultModel).toBe(modelRef);
    expect(note).toHaveBeenCalledWith(expect.stringContaining("Start LM Studio"), "LM Studio");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Wait for LM Studio to recover"),
      "LM Studio",
    );
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(text).toHaveBeenCalledTimes(2);
  });

  it("remote interactive setup stops when cancelled during retry discovery", async () => {
    const controller = new AbortController();
    const retry = createDeferred<{ reachable: true; status: 200; models: never[] }>();
    fetchModels
      .mockResolvedValueOnce({ reachable: false, models: [] })
      .mockImplementationOnce(() => retry.promise);
    const { prompter } = wizard(undefined, [true]);

    const setup = interactive({ prompter, isRemote: true, signal: controller.signal });
    await vi.waitFor(() => expect(fetchModels).toHaveBeenCalledTimes(2));
    controller.abort();
    retry.resolve({ reachable: true, status: 200, models: [] });

    await expect(setup).rejects.toMatchObject({ name: "AbortError" });
  });

  it("interactive Docker setup hints the host LM Studio endpoint and uses it for blank input", async () => {
    vi.stubEnv("OPENCLAW_DOCKER_SETUP", "1");
    const { prompter, text } = wizard(["", "", ""]);

    const result = await interactive({ prompter });

    const prompt = requireRecord(text.mock.calls[0]?.[0], "first text prompt");
    expect(prompt.initialValue).toBeUndefined();
    expect(prompt.placeholder).toBe("http://host.docker.internal:1234");
    expectDiscoveryRequest(localKey, undefined, "http://host.docker.internal:1234/v1");
    expect(providerOf(result.configPatch)).toMatchObject({
      baseUrl: "http://host.docker.internal:1234/v1",
      apiKey: localKey,
    });
    expectKeyless(result);
  });

  it.each([false, true])("accepts a blank key (header auth=%s)", async (headerAuth) => {
    const result = await interactive(
      headerAuth
        ? {
            config: buildConfig({ ...staleAuth, headers: customHeaders }),
            prompter: wizard([endpoint, "", ""]).prompter,
          }
        : { promptText: promptText("") },
    );
    expectDiscoveryRequest(
      headerAuth ? undefined : localKey,
      headerAuth ? customHeaders : undefined,
    );
    expectKeyless(result);
    const provider = providerOf(result.configPatch);
    if (headerAuth) {
      expect(provider.headers).toEqual(customHeaders);
      expect(provider).not.toHaveProperty("apiKey");
    } else {
      expect(provider.apiKey).toBe(localKey);
    }
  });

  it("re-authenticates while preserving headers and model aliases", async () => {
    const aliases = { "anthropic/claude-sonnet-4-6": { alias: "Sonnet" } };
    const result = await interactive({
      config: buildConfig(
        { ...staleAuth, headers: staleHeaders },
        { agents: { defaults: { models: aliases } } },
      ),
      promptText: promptText("fresh-prompt-key"),
    });
    expect(result.configPatch?.models?.mode).toBe("merge");
    expect(providerOf(result.configPatch)).toMatchObject({
      baseUrl,
      api: "openai-completions",
      auth: "api-key",
      apiKey: authEnv,
    });
    expect(providerOf(result.configPatch).headers).toEqual(staleHeaders);
    expect(result.defaultModel).toBe(modelRef);
    expect(result.profiles).toEqual([
      {
        profileId: "lmstudio:default",
        credential: { type: "api_key", provider: "lmstudio", key: "fresh-prompt-key" },
      },
    ]);
    expect(result.configPatch?.agents?.defaults?.models).toEqual({ ...aliases, [modelRef]: {} });
  });
});

const noKey = new Error('No API key found for provider "lmstudio".');
const headerAuth = { headers: { Authorization: "Bearer proxy-token" } };
type RuntimeCase = {
  config: Partial<ModelProviderConfig>;
  key?: string;
  source?: string;
  env?: NodeJS.ProcessEnv;
  expected?: string | RegExp;
};
describe("lmstudio-runtime", () => {
  beforeEach(() => resolveApiKeyForProviderMock.mockReset());
  it.each`
    name          | config                                              | key                         | source                        | env                                 | expected
    ${"blank"}    | ${{ auth: "api-key" }}                              | ${"   "}                    | ${"profile:lmstudio:default"} | ${{}}                               | ${/openclaw models auth login --provider lmstudio/}
    ${"missing"}  | ${{ auth: "api-key" }}                              | ${undefined}                | ${undefined}                  | ${{}}                               | ${/LM Studio API key is required/i}
    ${"fallback"} | ${{ auth: "api-key", apiKey: "${LM_API_TOKEN}" }}   | ${undefined}                | ${undefined}                  | ${{ LM_API_TOKEN: "template-key" }} | ${"template-key"}
    ${"local"}    | ${{ auth: "api-key" }}                              | ${localKey}                 | ${"synthetic"}                | ${{}}                               | ${localKey}
    ${"marker"}   | ${{}}                                               | ${CUSTOM_LOCAL_AUTH_MARKER} | ${"synthetic"}                | ${{}}                               | ${CUSTOM_LOCAL_AUTH_MARKER}
    ${"unset"}    | ${{ ...headerAuth, apiKey: "${LMSTUDIO_API_KEY}" }} | ${undefined}                | ${undefined}                  | ${{}}                               | ${undefined}
    ${"profile"}  | ${headerAuth}                                       | ${"stale-key"}              | ${"profile:lmstudio:default"} | ${{}}                               | ${undefined}
    ${"env"}      | ${headerAuth}                                       | ${"stale-key"}              | ${"env:LM_API_TOKEN"}         | ${{}}                               | ${undefined}
    ${"shell"}    | ${headerAuth}                                       | ${"stale-key"}              | ${"shell env: LM_API_TOKEN"}  | ${{}}                               | ${undefined}
  `("resolves runtime auth: $name", async ({ config, key, source, env, expected }: RuntimeCase) => {
    if (key === undefined) {
      resolveApiKeyForProviderMock.mockRejectedValueOnce(noKey);
    } else {
      resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: key, source, mode: "api-key" });
    }
    const result = runtimeKey({ config: buildConfig(config), env });
    if (expected instanceof RegExp) {
      await expect(result).rejects.toThrow(expected);
    } else {
      await expect(result).resolves.toBe(expected);
    }
  });

  type ConfiguredCase = { apiKey?: SecretInput; env: NodeJS.ProcessEnv; expected?: string };
  it.each`
    name              | apiKey                                                        | env                                                                 | expected
    ${"absent"}       | ${undefined}                                                  | ${{}}                                                               | ${undefined}
    ${"env marker"}   | ${"GOOGLE_API_KEY"}                                           | ${{ GOOGLE_API_KEY: "direct-key" }}                                 | ${"direct-key"}
    ${"nonrecursive"} | ${{ source: "env", provider: "default", id: "LM_API_TOKEN" }} | ${{ LM_API_TOKEN: "GOOGLE_API_KEY", GOOGLE_API_KEY: "nested-key" }} | ${undefined}
    ${"synthetic"}    | ${CUSTOM_LOCAL_AUTH_MARKER}                                   | ${{}}                                                               | ${undefined}
    ${"template"}     | ${"${LMSTUDIO_API_KEY}"}                                      | ${{ LMSTUDIO_API_KEY: "template-key" }}                             | ${"template-key"}
  `("resolves configured auth: $name", async ({ apiKey, env, expected }: ConfiguredCase) => {
    await expect(
      configuredKey({
        config: buildConfig({ apiKey }),
        env,
      }),
    ).resolves.toBe(expected);
  });

  it.each<SecretInput>([
    "${LMSTUDIO_API_KEY}",
    { source: "env", provider: "default", id: "LMSTUDIO_API_KEY" },
  ])("fails closed for unresolved %j unless explicitly allowed", async (apiKey) => {
    const options = { config: buildConfig({ apiKey }), env: {} };
    await expect(configuredKey(options)).rejects.toThrow('models.providers["lmstudio"].apiKey');
    await expect(configuredKey({ ...options, allowUnresolved: true })).resolves.toBeUndefined();
  });

  const headerToken = "${LMSTUDIO_HEADER_TEST_TOKEN}";
  type HeaderCase = {
    header: string;
    input: SecretInput;
    token?: string;
    expected?: string;
    load: boolean;
  };
  it.each`
    header            | input                                                                 | token                      | expected                   | load
    ${"X-Proxy-Auth"} | ${{ source: "env", provider: "default", id: "LMSTUDIO_PROXY_TOKEN" }} | ${undefined}               | ${undefined}               | ${false}
    ${"constructor"}  | ${headerToken}                                                        | ${undefined}               | ${undefined}               | ${true}
    ${"prototype"}    | ${headerToken}                                                        | ${undefined}               | ${undefined}               | ${true}
    ${"constructor"}  | ${"$" + headerToken}                                                  | ${undefined}               | ${headerToken}             | ${true}
    ${"prototype"}    | ${"$" + headerToken}                                                  | ${undefined}               | ${headerToken}             | ${true}
    ${"constructor"}  | ${headerToken}                                                        | ${"resolved-header-token"} | ${"resolved-header-token"} | ${true}
    ${"prototype"}    | ${headerToken}                                                        | ${"resolved-header-token"} | ${"resolved-header-token"} | ${true}
  `(
    "resolves $header header: $input / $token",
    async ({ header, input, token, expected, load }: HeaderCase) => {
      await withTempHome(async (home) => {
        let config = buildConfig({ headers: { [header]: input } });
        if (load) {
          const configPath = path.join(home, ".openclaw", "openclaw.json");
          vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
          vi.stubEnv("LMSTUDIO_HEADER_TEST_TOKEN", token);
          await fs.writeFile(configPath, JSON.stringify(config));
          config = getRuntimeConfig({
            pin: false,
            skipPluginValidation: true,
            skipShellEnvFallback: true,
          });
        }
        const headers = providerHeaders({
          config,
          env: {},
          headers: config.models?.providers?.lmstudio?.headers,
        });
        if (expected === undefined) {
          await expect(headers).rejects.toThrow(`models.providers.lmstudio.headers.${header}`);
        } else {
          expect(authHeaders({ headers: await headers })).toEqual({
            [header]: expected,
          });
        }
      });
    },
  );

  type HeadersCase = {
    input: Parameters<typeof authHeaders>[0];
    expected?: Record<string, string>;
  };
  it.each`
    name          | input                                                                                                | expected
    ${"absent"}   | ${{}}                                                                                                | ${undefined}
    ${"blank"}    | ${{ apiKey: "   " }}                                                                                 | ${undefined}
    ${"local"}    | ${{ apiKey: localKey }}                                                                              | ${undefined}
    ${"trim"}     | ${{ apiKey: "  sk-test  " }}                                                                         | ${{ Authorization: "Bearer sk-test" }}
    ${"header"}   | ${{ apiKey: localKey, ...headerAuth }}                                                               | ${headerAuth.headers}
    ${"override"} | ${{ apiKey: "sk-new", json: true, headers: { authorization: "Bearer sk-old", "X-Proxy": "proxy" } }} | ${{ "Content-Type": "application/json", "X-Proxy": "proxy", Authorization: "Bearer sk-new" }}
  `("builds auth headers: $name", ({ input, expected }: HeadersCase) => {
    expect(authHeaders(input)).toEqual(expected);
  });
});
