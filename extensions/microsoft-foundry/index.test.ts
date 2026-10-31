import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ProviderPrepareRuntimeAuthContext,
  ProviderPrepareRuntimeAuthContextV2,
} from "openclaw/plugin-sdk/core";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type {
  ProviderPlugin,
  ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execAz, getAccessTokenResultAsync } from "./cli.js";
import plugin from "./index.js";
import {
  promptApiKeyEndpointAndModel,
  promptEndpointAndModelManually,
  selectFoundryDeployment,
} from "./onboard.js";
import {
  COGNITIVE_SERVICES_RESOURCE,
  FOUNDRY_ANTHROPIC_SCOPE,
  buildFoundryAuthResult,
  formatFoundryApiLabel,
  type FoundryProviderApi,
  isFoundryMaiImageModel,
  requiresFoundryMaxCompletionTokens,
  usesFoundryResponsesByDefault,
} from "./shared.js";
const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn(() => ({ profiles: {} })));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: ((file: string, ...args: unknown[]) =>
      file === "az"
        ? execFileSyncMock(file, ...args)
        : Reflect.apply(actual.execFileSync, actual, [
            file,
            ...args,
          ])) as typeof actual.execFileSync,
  };
});

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return { ...actual, runExec: execFileMock };
});

vi.mock("openclaw/plugin-sdk/provider-auth", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
    "openclaw/plugin-sdk/provider-auth",
  );
  return { ...actual, ensureAuthProfileStoreAsync: ensureAuthProfileStoreMock };
});

function registerProvider() {
  const register = vi.fn<(provider: ProviderPlugin) => void>();
  plugin.register(createTestPluginApi({ registerProvider: register }));
  return expectDefined(register.mock.calls[0]?.[0], "Microsoft Foundry provider");
}

function prepareAuth(provider = registerProvider()) {
  const prepare = expectDefined(provider.prepareRuntimeAuthV2, "Foundry runtime auth hook");
  return async (overrides: Partial<ProviderPrepareRuntimeAuthContextV2> = {}) =>
    expectDefined(await prepare(authContext(overrides)), "Foundry runtime auth result");
}

function providerPatch(result: ReturnType<typeof buildFoundryAuthResult>) {
  return expectDefined(result.configPatch?.models?.providers?.[providerId], "Foundry config patch");
}

function configuredProvider(config: OpenClawConfig) {
  return expectDefined(config.models?.providers?.[providerId], "configured Foundry provider");
}

const baseUrl = "https://example.services.ai.azure.com/openai/v1";
const endpoint = "https://example.services.ai.azure.com";
const providerId = "microsoft-foundry";
const defaultModelId = "gpt-5.4";
const profileId = "microsoft-foundry:entra";
const apiKeyProfileId = "microsoft-foundry:default";
const agentDir = "/tmp/test-agent";
const loginError = "Please run 'az login' to setup account.";
const foundryTokenCacheMaxEntries = 128;
let runtimeAuthTestSequence = 0;
let runtimeAuthTestTenantId = "tenant-0";

function makeModel(
  overrides: Partial<Omit<ProviderPrepareRuntimeAuthContext["model"], "headers">> & {
    api?: FoundryProviderApi;
    headers?: Record<string, string>;
  } = {},
) {
  return {
    provider: providerId,
    id: defaultModelId,
    name: defaultModelId,
    api: "openai-responses" as const,
    baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  };
}

function makeConfig({
  profileIds = [],
  orderedProfileIds,
  ...provider
}: {
  profileIds?: string[];
  orderedProfileIds?: string[];
  models?: ModelDefinitionConfig[];
  baseUrl?: string;
  api?: FoundryProviderApi;
  timeoutSeconds?: number;
} = {}) {
  const profiles = Object.fromEntries(
    profileIds.map((id) => [id, { provider: providerId, mode: "api_key" as const }]),
  );
  const modelProvider = {
    baseUrl,
    api: "openai-responses" as const,
    models: [makeModel()],
    ...provider,
  };
  return {
    auth: {
      profiles,
      ...(orderedProfileIds ? { order: { [providerId]: orderedProfileIds } } : {}),
    },
    models: { providers: { [providerId]: modelProvider } },
  } satisfies OpenClawConfig;
}

function entraStore(
  overrides: Partial<Pick<FoundryAuthParams, "api" | "endpoint" | "modelId" | "tenantId">> & {
    modelName?: string;
    authMethod?: FoundryAuthParams["authMethod"];
  } = {},
  id = profileId,
) {
  const metadata = {
    authMethod: "entra-id",
    endpoint,
    modelId: "custom-deployment",
    modelName: defaultModelId,
    api: "openai-responses",
    tenantId: runtimeAuthTestTenantId,
    ...overrides,
  };
  return {
    profiles: {
      [id]: { type: "api_key", provider: providerId, metadata },
    },
  };
}

function authContext(overrides: Partial<ProviderPrepareRuntimeAuthContextV2> = {}) {
  const modelId = overrides.modelId ?? "custom-deployment";
  return {
    capability: "chat" as const,
    provider: providerId,
    modelId,
    model: makeModel({ id: modelId }),
    apiKey: "__entra_id_dynamic__",
    authMode: "api_key" as const,
    profileId,
    env: process.env,
    agentDir,
    ...overrides,
  };
}

function tokenResponse(accessToken: string, expiresInMs = 60 * 60_000) {
  return {
    stdout: JSON.stringify({
      accessToken,
      expiresOn: new Date(Date.now() + expiresInMs).toISOString(),
    }),
    stderr: "",
  };
}

function mockAzureCliToken(accessToken: string, expiresInMs = 60_000) {
  execFileMock.mockImplementationOnce(async () => tokenResponse(accessToken, expiresInMs));
}

function deferredCliResponse(result: () => ReturnType<typeof tokenResponse>) {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  execFileMock.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return result();
  });
  return { started: started.promise, release: release.resolve };
}

type FoundryAuthParams = Parameters<typeof buildFoundryAuthResult>[0];

function buildAuthResult(params: Pick<FoundryAuthParams, "modelId"> & Partial<FoundryAuthParams>) {
  const apiKeyAuth = params.authMethod === "api-key";
  return buildFoundryAuthResult({
    profileId: apiKeyAuth ? apiKeyProfileId : profileId,
    apiKey: apiKeyAuth ? "test-api-key" : "__entra_id_dynamic__",
    endpoint,
    api: "openai-responses",
    authMethod: "entra-id",
    ...params,
  });
}

function builtModel(params: Pick<FoundryAuthParams, "modelId"> & Partial<FoundryAuthParams>) {
  return providerPatch(buildAuthResult(params)).models?.[0];
}

function wrapStream(streamFn: StreamFn, model = makeModel()) {
  return registerProvider().wrapStreamFn?.({
    streamFn,
    modelId: model.id,
    model,
    extraParams: {},
    config: {},
    agentDir,
  } as never);
}

function normalizeAlias(overrides: Partial<ReturnType<typeof makeModel>> = {}) {
  return registerProvider().normalizeResolvedModel?.({
    provider: providerId,
    modelId: "prod-primary",
    model: makeModel({
      id: "prod-primary",
      name: "production alias",
      api: "openai-completions",
      reasoning: true,
      ...overrides,
    }),
  });
}

function mockAzureAccount(subscriptions: string[]) {
  const account = (id: string) => ({
    id,
    name: id,
    tenantId: "tenant-one",
    state: "Enabled",
    user: { name: "user@example.com" },
  });
  const responses = new Map([
    ["version --output none", ""],
    ["account show --output json", JSON.stringify(account("sub-one"))],
    ["account list --output json --all", JSON.stringify(subscriptions.map(account))],
  ]);
  execFileSyncMock.mockImplementation((_file: string, args: string[]) => {
    const command = args.join(" ");
    if (!responses.has(command)) {
      throw new Error(`unexpected az command: ${command}`);
    }
    return responses.get(command);
  });
}

function prepareForTenants(prefix: string) {
  const prepare = prepareAuth();
  return async (index: number) => {
    ensureAuthProfileStoreMock.mockReturnValueOnce(
      entraStore({ tenantId: `${prefix}-${runtimeAuthTestTenantId}-${index}` }),
    );
    return prepare();
  };
}

async function selectModel(config: OpenClawConfig, modelId: string) {
  const provider = registerProvider();
  await provider.onModelSelected?.({
    config,
    model: `microsoft-foundry/${modelId}`,
    prompter: {} as never,
    agentDir,
  });
}

function findAuthMethod(id: string) {
  return expectDefined(
    registerProvider().auth.find((entry) => entry.id === id),
    `Foundry ${id} auth`,
  );
}

function authPrompt(modelId: string) {
  return vi.fn().mockResolvedValueOnce(endpoint).mockResolvedValueOnce(modelId);
}

function authSetup(prompter: Record<string, unknown>) {
  return {
    config: {},
    agentDir,
    prompter: {
      confirm: vi.fn(async () => true),
      note: vi.fn(async () => undefined),
      ...prompter,
    },
  };
}

describe("microsoft-foundry plugin", () => {
  beforeEach(() => {
    runtimeAuthTestSequence += 1;
    runtimeAuthTestTenantId = `tenant-${runtimeAuthTestSequence}`;
    execFileMock.mockReset();
    execFileSyncMock.mockReset();
    ensureAuthProfileStoreMock.mockReset().mockReturnValue({ profiles: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each`
    behavior                         | options                                                                                                                                                                                                                                                    | expected
    ${"unordered auth profiles"}     | ${{ profileIds: [apiKeyProfileId, profileId] }}                                                                                                                                                                                                            | ${{}}
    ${"timeout-only overlay"}        | ${{ baseUrl: "", models: [], timeoutSeconds: 120 }}                                                                                                                                                                                                        | ${{ models: [], timeoutSeconds: 120 }}
    ${"per-model endpoint"}          | ${{ models: [makeModel({ id: defaultModelId, name: "claude-fable-5", api: "anthropic-messages", baseUrl: "https://claude-resource.services.ai.azure.com/anthropic", reasoning: true, input: ["text", "image"] })] }}                                       | ${{ baseUrl: "https://claude-resource.services.ai.azure.com/anthropic", models: [{ baseUrl: "https://claude-resource.services.ai.azure.com/anthropic" }] }}
    ${"new GPT routing from Claude"} | ${{ baseUrl: `${endpoint}/anthropic`, api: "anthropic-messages", models: [] }}                                                                                                                                                                             | ${{ api: "openai-responses", baseUrl, models: [{ id: defaultModelId, reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000, compat: { supportsReasoningEffort: true }, api: "openai-responses", baseUrl }] }}
    ${"other configured models"}     | ${{ profileIds: [apiKeyProfileId], orderedProfileIds: [apiKeyProfileId], models: [{ ...makeModel({ id: "alias-one" }), api: undefined, baseUrl: undefined }, { ...makeModel({ id: "alias-two", name: "gpt-4o" }), api: undefined, baseUrl: undefined }] }} | ${{ models: [{ id: "alias-one", input: ["text", "image"] }, { id: "alias-two" }] }}
  `("selects a model with $behavior", async ({ options, expected }) => {
    const config = makeConfig(options);
    await selectModel(config, options.models?.[0]?.id ?? defaultModelId);
    expect(configuredProvider(config)).toMatchObject(expected);
    expect(config.auth?.order?.[providerId]).toEqual(options.orderedProfileIds);
  });

  it("reports malformed Azure CLI token JSON with an owned error", async () => {
    execFileMock.mockResolvedValueOnce({ stdout: "{not json", stderr: "" });
    await expect(getAccessTokenResultAsync()).rejects.toThrow(
      "Azure CLI returned malformed access token JSON.",
    );
  });

  it("hard-stops a synchronous Azure CLI command at its timeout", () => {
    execFileSyncMock.mockReturnValue("ok");
    execAz(["version", "--output", "none"]);
    const options = execFileSyncMock.mock.calls[0]?.[2];
    expect(options).toMatchObject({ timeout: 30_000, killSignal: "SIGKILL" });
  });

  it("fails clearly when the selected Azure subscription is not in the enabled list", async () => {
    mockAzureAccount(["sub-one", "sub-two"]);
    await expect(
      findAuthMethod("entra-id").run(
        authSetup({ select: vi.fn(async () => "missing-subscription") }) as never,
      ),
    ).rejects.toThrow("Selected subscription not found: missing-subscription");
  });

  it.each`
    configuredUrl                                                                    | metadata      | expectedUrl
    ${"not a url"}                                                                   | ${entraStore} | ${baseUrl}
    ${"https://example.services.ai.azure.com/api/projects/demo/openai/v1/responses"} | ${undefined}  | ${"https://example.services.ai.azure.com/api/projects/demo/openai/v1"}
  `(
    "resolves the runtime endpoint from $configuredUrl",
    async ({ configuredUrl, metadata, expectedUrl }) => {
      mockAzureCliToken("test-token-placeholder");
      if (metadata) {
        ensureAuthProfileStoreMock.mockReturnValueOnce(metadata());
      }
      const prepared = await prepareAuth()({ model: makeModel({ baseUrl: configuredUrl }) });
      expect(prepared).toMatchObject({
        baseUrl: expectedUrl,
        request: { auth: { mode: "authorization-bearer", token: "test-token-placeholder" } },
      });
    },
  );

  it.each([
    ["openai-responses", "api-key"],
    ["anthropic-messages", "x-api-key"],
  ] as const)("binds %s API-key auth to the active profile", async (api, headerName) => {
    const prepareRuntimeAuth = prepareAuth();
    const prepared = await prepareRuntimeAuth({
      apiKey: "profile-api-key",
      profileId: apiKeyProfileId,
      model: makeModel({ api }),
    });
    expect(prepared).toEqual({
      apiKey: "profile-api-key",
      request: {
        auth: { mode: "header", headerName, value: "profile-api-key" },
      },
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not reuse OpenAI Entra tokens for Anthropic Foundry deployments", async () => {
    const prepareRuntimeAuth = prepareAuth();
    mockAzureCliToken("gpt-token");
    mockAzureCliToken("claude-token");
    ensureAuthProfileStoreMock.mockReturnValue(entraStore({ modelId: "deployment-gpt5" }));
    const gptPrepared = await prepareRuntimeAuth({ modelId: "deployment-gpt5" });
    const claudePrepared = await prepareRuntimeAuth({
      modelId: "deployment-fable",
      model: makeModel({
        id: "deployment-fable",
        name: "claude-fable-5",
        api: "anthropic-messages",
        baseUrl: `${endpoint}/anthropic`,
      }),
    });
    expect(gptPrepared).toMatchObject({
      baseUrl,
      apiKey: "gpt-token",
      request: { auth: { mode: "authorization-bearer", token: "gpt-token" } },
    });
    expect(claudePrepared).toMatchObject({
      baseUrl: `${endpoint}/anthropic`,
      apiKey: "claude-token",
    });
    const cliArgs = execFileMock.mock.calls.map((call) => call[1]);
    expect(cliArgs[0]).toEqual(expect.arrayContaining(["--resource", COGNITIVE_SERVICES_RESOURCE]));
    expect(cliArgs[1]).toEqual(expect.arrayContaining(["--scope", FOUNDRY_ANTHROPIC_SCOPE]));
  });

  it("reclaims expired tokens before evicting an older live account", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    execFileMock.mockImplementation(async () => tokenResponse("synthetic-expiry-token"));
    const prepareForTenant = prepareForTenants("expiry");
    for (let index = 0; index < foundryTokenCacheMaxEntries - 1; index++) {
      await prepareForTenant(index);
    }
    mockAzureCliToken("synthetic-short-token", 6 * 60_000);
    await prepareForTenant(foundryTokenCacheMaxEntries - 1);
    clock.mockReturnValue(now + 7 * 60_000);
    await prepareForTenant(foundryTokenCacheMaxEntries);
    await prepareForTenant(0);
    expect(execFileMock).toHaveBeenCalledTimes(foundryTokenCacheMaxEntries + 1);
    await prepareForTenant(foundryTokenCacheMaxEntries - 1);
    expect(execFileMock).toHaveBeenCalledTimes(foundryTokenCacheMaxEntries + 2);
  });

  it("keeps one active refresh while settled account entries churn", async () => {
    const release = createDeferred<void>();
    execFileMock.mockImplementation(async () => tokenResponse("synthetic-churn-token"));
    execFileMock.mockImplementationOnce(async () => {
      await release.promise;
      return tokenResponse("synthetic-held-token");
    });
    const prepareForTenant = prepareForTenants("churn");
    const pending = [prepareForTenant(0)];
    try {
      for (let index = 1; index <= foundryTokenCacheMaxEntries + 1; index++) {
        await prepareForTenant(index);
      }
      pending.push(prepareForTenant(0));
      expect(execFileMock).toHaveBeenCalledTimes(foundryTokenCacheMaxEntries + 2);
      release.resolve();
      const results = await Promise.all(pending);
      expect(results.map((result) => result.apiKey)).toEqual([
        "synthetic-held-token",
        "synthetic-held-token",
      ]);
      await prepareForTenant(0);
      expect(execFileMock).toHaveBeenCalledTimes(foundryTokenCacheMaxEntries + 2);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("refreshes an evicted account through an Azure CLI subprocess", async ({ signal }) => {
    const { runExec: runRealExec } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/process-runtime")
    >("openclaw/plugin-sdk/process-runtime");
    const nodeExecPath = resolveTestNodeExecPath();
    const proofDir = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-cache-proof-"));
    try {
      const binDir = path.join(proofDir, "bin");
      await fs.mkdir(binDir);
      const fakeAz = path.join(proofDir, "fake-az.mjs");
      await fs.writeFile(
        fakeAz,
        String.raw`#!/usr/bin/env node
  const args = process.argv.slice(2);
  process.stdout.write(JSON.stringify({
    accessToken: "synthetic-cli-" + args[args.indexOf("--tenant") + 1],
    expiresOn: new Date(Date.now() + 60 * 60_000).toISOString(),
  }));
  `,
      );
      if (process.platform === "win32") {
        await fs.writeFile(
          path.join(binDir, "az.cmd"),
          `@echo off\r\n"${nodeExecPath}" "${fakeAz}" %*\r\n`,
        );
      } else {
        await fs.chmod(fakeAz, 0o700);
        await fs.symlink(fakeAz, path.join(binDir, "az"));
      }
      const tenant = (index: number) => `boundary-${runtimeAuthTestTenantId}-${index}`;
      const prepareForTenant = prepareForTenants("boundary");
      execFileMock.mockResolvedValue(tokenResponse("synthetic-seed-token"));
      // Fill through the provider without launching a process for each cached account.
      for (let index = 0; index <= foundryTokenCacheMaxEntries; index++) {
        await prepareForTenant(index);
      }
      execFileMock.mockImplementation(
        (command: string, args: string[], options: { logOutput: boolean; timeoutMs: number }) =>
          runRealExec(command, args, {
            ...options,
            signal,
            cwd: proofDir,
            baseEnv: {
              PATH: [
                binDir,
                path.dirname(nodeExecPath),
                ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"]),
              ].join(path.delimiter),
              HOME: proofDir,
              USERPROFILE: proofDir,
              SystemRoot: process.env.SystemRoot,
              ComSpec: process.env.ComSpec,
              OPENCLAW_STATE_DIR: path.join(proofDir, "state"),
              AZURE_CONFIG_DIR: path.join(proofDir, "azure"),
            },
          }),
      );
      const refreshed = await prepareForTenant(0);
      expect(refreshed).toMatchObject({
        apiKey: `synthetic-cli-${tenant(0)}`,
        request: { auth: { mode: "authorization-bearer", token: `synthetic-cli-${tenant(0)}` } },
      });
      expect(execFileMock.mock.calls.at(-1)?.[2]).toEqual({ logOutput: false, timeoutMs: 30_000 });
      expect(await prepareForTenant(0)).toEqual(refreshed);
      expect(execFileMock).toHaveBeenCalledTimes(foundryTokenCacheMaxEntries + 2);
    } finally {
      await fs.rm(proofDir, { recursive: true, force: true });
    }
  });

  it("clears failed refresh state so later concurrent retries succeed", async () => {
    const prepareRuntimeAuth = prepareAuth();
    const failed = deferredCliResponse(() => {
      throw Object.assign(new Error("az failed"), { stderr: loginError, stdout: "" });
    });
    const recovery = deferredCliResponse(() => tokenResponse("recovered-token", 10 * 60_000));
    ensureAuthProfileStoreMock.mockReturnValue(entraStore());
    const runtimeContext = authContext();
    const pending = [prepareRuntimeAuth(runtimeContext), prepareRuntimeAuth(runtimeContext)];
    let settled = Promise.allSettled(pending);
    try {
      await failed.started;
      expect(execFileMock).toHaveBeenCalledTimes(1);
      failed.release();
      for (const result of await settled) {
        expect(result).toMatchObject({
          status: "rejected",
          reason: { message: expect.stringContaining("Azure CLI is not logged in") },
        });
      }
      expect(execFileMock).toHaveBeenCalledTimes(1);
      const retries = [prepareRuntimeAuth(runtimeContext), prepareRuntimeAuth(runtimeContext)];
      pending.push(...retries);
      settled = Promise.allSettled(pending);
      await recovery.started;
      expect(execFileMock).toHaveBeenCalledTimes(2);
      recovery.release();
      const results = await Promise.all(retries);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(results.map((result) => result.apiKey)).toEqual([
        "recovered-token",
        "recovered-token",
      ]);
    } finally {
      // Broken dedupe can consume the recovery response in the first pair.
      failed.release();
      recovery.release();
      await settled;
    }
  });

  it.each([undefined, { canonicalModelId: "gpt-5-mini" }])(
    "preserves manual limits through repeated selection and normalization with params %j",
    async (params) => {
      const config = makeConfig({
        models: [makeModel({ id: "prod-mini", name: "gpt-5-mini", params })],
      });
      const provider = registerProvider();
      for (let selection = 0; selection < 2; selection++) {
        await selectModel(config, "prod-mini");
        const model = configuredProvider(config).models[0]!;
        expect(model).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
        expect(
          provider.normalizeResolvedModel?.({
            provider: providerId,
            modelId: model.id,
            model: makeModel({ id: model.id, name: model.name, params: model.params }),
          }),
        ).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
      }
    },
  );

  it("defaults Azure OpenAI model families to the documented API surfaces", () => {
    expect(usesFoundryResponsesByDefault("o4-mini")).toBe(true);
    expect(usesFoundryResponsesByDefault("DeepSeek-V4-Pro")).toBe(true);
    expect(usesFoundryResponsesByDefault("MAI-DS-R1")).toBe(false);
    expect(requiresFoundryMaxCompletionTokens("o3")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("gpt-4o")).toBe(false);
    expect(isFoundryMaiImageModel("MAI-Image-2.5-Flash")).toBe(true);
  });

  it("labels all Foundry API surfaces for onboarding summaries", () => {
    expect(formatFoundryApiLabel("openai-completions")).toBe("Chat Completions");
    expect(formatFoundryApiLabel("openai-responses")).toBe("Responses");
    expect(formatFoundryApiLabel("anthropic-messages")).toBe("Anthropic Messages");
  });

  it.each`
    modelName               | api                     | reasoning | input                | contextWindow | maxTokens  | compat                                                                                                                                      | thinkingLevelMap
    ${"MAI-DS-R1"}          | ${"openai-completions"} | ${true}   | ${["text"]}          | ${163_840}    | ${163_840} | ${{ supportsReasoningEffort: false, maxTokensField: "max_tokens" }}                                                                         | ${undefined}
    ${"claude-3.5-sonnet"}  | ${"anthropic-messages"} | ${false}  | ${["text", "image"]} | ${128_000}    | ${16_384}  | ${undefined}                                                                                                                                | ${undefined}
    ${"gpt-5.1-codex-mini"} | ${"openai-completions"} | ${true}   | ${["text", "image"]} | ${400_000}    | ${128_000} | ${{ supportsReasoningEffort: true, supportedReasoningEfforts: ["none", "low", "medium", "high"], maxTokensField: "max_completion_tokens" }} | ${{ off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }}
    ${"gpt-5-codex"}        | ${"openai-completions"} | ${true}   | ${["text", "image"]} | ${400_000}    | ${128_000} | ${{ supportedReasoningEfforts: ["low", "medium", "high"] }}                                                                                 | ${{ off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null }}
    ${"gpt-5-chat"}         | ${"openai-completions"} | ${false}  | ${["text", "image"]} | ${128_000}    | ${16_384}  | ${{ supportsReasoningEffort: false, maxTokensField: "max_completion_tokens" }}                                                              | ${undefined}
  `("builds $modelName", ({ modelName, api, compat, thinkingLevelMap, ...expected }) => {
    const model = builtModel({ modelId: "prod-model", modelNameHint: modelName, api });
    expect(model).toMatchObject({ id: "prod-model", name: modelName, api, ...expected });
    expect(model?.compat).toEqual(compat && expect.objectContaining(compat));
    expect(model?.thinkingLevelMap).toEqual(thinkingLevelMap);
  });

  it("skips chat connection probes for MAI image deployments", async () => {
    mockAzureAccount([]);
    const select = vi
      .fn()
      .mockResolvedValueOnce("mai-image")
      .mockResolvedValueOnce("MAI-Image-2.5");
    const result = await findAuthMethod("entra-id").run(
      authSetup({ text: authPrompt("prod-image"), select }) as never,
    );
    expect(
      execFileSyncMock.mock.calls.some((call) => {
        const args = call[1];
        return Array.isArray(args) && args[0] === "account" && args[1] === "get-access-token";
      }),
    ).toBe(false);
    expect(result.configPatch?.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "microsoft-foundry/prod-image",
    });
    expect(result.configPatch?.agents?.defaults).not.toHaveProperty("imageGenerationModel");
    expect(result.defaultModel).toBeUndefined();
    expect(providerPatch(result).models?.[0]?.name).toBe("MAI-Image-2.5");
  });

  it("does not reuse stale API-key model metadata when selecting a different deployment", async () => {
    ensureAuthProfileStoreMock.mockReturnValueOnce(
      entraStore(
        {
          authMethod: "api-key",
          modelId: "prod-fable",
          modelName: "claude-fable-5",
          api: "anthropic-messages",
        },
        apiKeyProfileId,
      ),
    );
    const select = vi.fn(async (params: { initialValue?: string }) => params.initialValue);
    const result = await findAuthMethod("api-key").run({
      ...authSetup({ text: authPrompt("prod-gpt"), select }),
      opts: { azureOpenaiApiKey: "test-api-key" },
      secretInputMode: "plaintext",
    } as never);
    const model = result?.configPatch?.models?.providers?.["microsoft-foundry"]?.models?.[0];
    expect(model).toMatchObject({
      id: "prod-gpt",
      name: "prod-gpt",
      api: "openai-completions",
      reasoning: false,
    });
    expect(model?.thinkingLevelMap).toBeUndefined();
  });

  it.each`
    auth         | prompt                            | modelNameHint              | error
    ${"API key"} | ${promptApiKeyEndpointAndModel}   | ${"claude-fable-5"}        | ${expect.stringContaining("Entra ID auth")}
    ${"Entra"}   | ${promptEndpointAndModelManually} | ${"claude-mythos-preview"} | ${undefined}
  `(
    "validates Entra-only Claude models during $auth setup",
    async ({ prompt, modelNameHint, error }) => {
      const text = authPrompt("prod-mythos").mockImplementationOnce(
        async (params: { validate?: (value: string) => string | undefined }) => {
          expect(params.validate?.("claude-fable-5")).toBeUndefined();
          expect(params.validate?.("claude-mythos-preview")).toEqual(error);
          return modelNameHint;
        },
      );
      const selection = await prompt({
        prompter: { text, select: vi.fn(async () => "claude") },
      } as never);
      expect(selection).toEqual({
        endpoint,
        modelId: "prod-mythos",
        modelNameHint,
        api: "anthropic-messages",
      });
    },
  );

  it.each`
    overrides                                         | expected
    ${{ input: ["text", "image"] }}                   | ${{ name: "production alias", reasoning: true, input: ["text", "image"], compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" } }}
    ${{ compat: { supportsReasoningEffort: false } }} | ${{ reasoning: true, compat: { supportsReasoningEffort: false } }}
  `("preserves explicit alias capabilities: $overrides", ({ overrides, expected }) => {
    expect(normalizeAlias(overrides)).toMatchObject(expected);
  });

  it.each(["openai-responses", "openai-completions"] as const)(
    "wraps only %s replay streams",
    async (api) => {
      const model = makeModel({ api, reasoning: true, compat: { supportsStore: false } });
      const stream = vi.fn<StreamFn>(() => ({}) as never);
      const wrapped = wrapStream(stream, model);
      if (api === "openai-responses") {
        await wrapped?.(model as never, { systemPrompt: "system", messages: [] } as never, {});
        expect(stream.mock.calls[0]?.[2]).toMatchObject({ replayResponsesItemIds: true });
      } else {
        expect(wrapped).toBe(stream);
      }
    },
  );

  it.each`
    canonicalModelId           | defaultLevel  | levels
    ${"claude-opus-5"}         | ${"high"}     | ${"off minimal low medium high xhigh adaptive max"}
    ${"claude-fable-5"}        | ${"medium"}   | ${"low medium high xhigh max"}
    ${"claude-opus-4-6"}       | ${"adaptive"} | ${"off minimal low medium high adaptive max"}
    ${"claude-sonnet-4-6"}     | ${"adaptive"} | ${"off minimal low medium high adaptive max"}
    ${"claude-opus-4-1"}       | ${undefined}  | ${"off minimal low medium high"}
    ${"claude-opus-4-5"}       | ${undefined}  | ${"off minimal low medium high"}
    ${"claude-sonnet-4-5"}     | ${undefined}  | ${"off minimal low medium high"}
    ${"claude-haiku-4-5"}      | ${undefined}  | ${"off minimal low medium high"}
    ${"claude-mythos-preview"} | ${"adaptive"} | ${"minimal low medium high adaptive"}
    ${undefined}               | ${undefined}  | ${undefined}
  `(
    "resolves the $canonicalModelId thinking profile",
    ({ canonicalModelId, defaultLevel, levels }) => {
      const result = registerProvider().resolveThinkingProfile?.({
        provider: providerId,
        modelId: "prod-opaque",
        params: { canonicalModelId },
      });
      if (levels === undefined) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toMatchObject({ levels: levels.split(" ").map((id: string) => ({ id })) });
        if (defaultLevel !== undefined) {
          expect(result?.defaultLevel).toBe(defaultLevel);
        }
      }
    },
  );

  it("keeps bounded Azure CLI error details UTF-16 safe", async () => {
    const prefix = "x".repeat(299);
    execFileMock.mockRejectedValueOnce(
      Object.assign(new Error("az failed"), { stderr: `${prefix}😀tail`, stdout: "" }),
    );
    await expect(getAccessTokenResultAsync()).rejects.toMatchObject({
      message: `az failed: ${prefix}`,
    });
  });

  it("persists discovered deployments, orders profiles and clears provider-level secrets", () => {
    const result = buildAuthResult({
      apiKey: { source: "env", provider: "default", id: "AZURE_OPENAI_API_KEY" },
      authMethod: "api-key",
      currentProviderProfileIds: [profileId, apiKeyProfileId],
      modelId: "deployment-gpt5",
      modelNameHint: "gpt-5.4",
      deployments: [
        { name: "deployment-gpt5", modelName: "gpt-5.4", api: "openai-responses" },
        { name: "deployment-gpt4o", modelName: "gpt-4o", api: "openai-responses" },
        { name: "deployment-fable", modelName: "claude-fable-5", api: "anthropic-messages" },
      ],
    });
    const provider = providerPatch(result);
    expect(result.configPatch?.auth?.order?.[providerId]).toEqual([apiKeyProfileId, profileId]);
    for (const key of ["apiKey", "authHeader", "headers"] as const) {
      expect(provider[key]).toBeUndefined();
      expect(Object.hasOwn(provider, key)).toBe(true);
    }
    expect(provider?.models?.map((model) => [model.id, model.baseUrl])).toEqual([
      ["deployment-gpt5", baseUrl],
      ["deployment-gpt4o", baseUrl],
      ["deployment-fable", `${endpoint}/anthropic`],
    ]);
    expect(result.defaultModel).toBe("microsoft-foundry/deployment-gpt5");
    expect(provider.models?.[0]).toMatchObject({
      input: ["text", "image"],
      compat: { supportsStore: false, maxTokensField: "max_completion_tokens" },
    });
  });
});

describe("selectFoundryDeployment", () => {
  const resource = {
    id: "/sub/x/rg/y/account/z",
    accountName: "foundry-resource",
    kind: "AIServices" as const,
    resourceGroup: "rg",
    endpoint,
    projects: [],
  };
  it.each`
    deployments                                                                                            | selected
    ${[{ name: "prod-gpt", modelName: "gpt-5.4" }, { name: "prod-claude", modelName: "claude-opus-4-6" }]} | ${"prod-claude"}
    ${[{ name: "only-claude", modelName: "claude-3.5-sonnet" }]}                                           | ${"only-claude"}
  `(
    "selects $selected without filtering supported deployments",
    async ({ deployments, selected }) => {
      const select = vi.fn(async () => selected);
      const ctx = { prompter: { select, note: vi.fn() } } as never;
      expect(await selectFoundryDeployment(ctx, resource, deployments)).toEqual({
        selected: deployments.find((entry: { name: string }) => entry.name === selected),
        supported: deployments,
      });
      if (deployments.length > 1) {
        expect(select.mock.calls[0]).toEqual([
          expect.objectContaining({
            options: deployments.map((entry: { name: string }) =>
              expect.objectContaining({ value: entry.name }),
            ),
          }),
        ]);
      }
    },
  );
});
