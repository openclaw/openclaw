import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderPrepareRuntimeAuthContext } from "openclaw/plugin-sdk/core";
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
  extractFoundryEndpoint,
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
  expect(register).toHaveBeenCalledTimes(1);
  const provider = register.mock.calls[0]?.[0];
  assert(provider, "expected Microsoft Foundry provider");
  return provider;
}

function prepareAuth(provider = registerProvider()) {
  const prepare = provider.prepareRuntimeAuth;
  assert(prepare, "expected Microsoft Foundry runtime auth hook");
  return async (overrides: Partial<ProviderPrepareRuntimeAuthContext> = {}) => {
    const result = await prepare(authContext(overrides));
    assert(result, "expected Microsoft Foundry runtime auth result");
    return result;
  };
}

function providerPatch(result: ReturnType<typeof buildFoundryAuthResult>) {
  const provider = result.configPatch?.models?.providers?.["microsoft-foundry"];
  assert(provider, "expected Microsoft Foundry provider config patch");
  return provider;
}

function configuredProvider(config: OpenClawConfig) {
  const provider = config.models?.providers?.[providerId];
  assert(provider, "expected configured Microsoft Foundry provider");
  return provider;
}

const baseUrl = "https://example.services.ai.azure.com/openai/v1";
const endpoint = "https://example.services.ai.azure.com";
const providerId = "microsoft-foundry";
const defaultModelId = "gpt-5.4";
const profileId = "microsoft-foundry:entra";
const agentDir = "/tmp/test-agent";
const loginError = "Please run 'az login' to setup account.";
const foundryTokenCacheMaxEntries = 128;
let runtimeAuthTestSequence = 0;
let runtimeAuthTestTenantId = "tenant-0";

function makeModel(
  overrides: Partial<ProviderPrepareRuntimeAuthContext["model"]> & {
    api?: FoundryProviderApi;
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
  return {
    auth: {
      profiles: Object.fromEntries(
        profileIds.map((id) => [id, { provider: providerId, mode: "api_key" as const }]),
      ),
      ...(orderedProfileIds ? { order: { [providerId]: orderedProfileIds } } : {}),
    },
    models: {
      providers: {
        [providerId]: {
          baseUrl,
          api: "openai-responses" as const,
          models: [makeModel()],
          ...provider,
        },
      },
    },
  } satisfies OpenClawConfig;
}

function entraStore(
  overrides: Partial<{
    api: "openai-responses" | "openai-completions" | "anthropic-messages";
    endpoint: string;
    modelId: string;
    modelName: string;
    tenantId: string;
  }> = {},
) {
  return {
    profiles: {
      [profileId]: {
        type: "api_key",
        provider: providerId,
        metadata: {
          authMethod: "entra-id",
          endpoint,
          modelId: "custom-deployment",
          modelName: defaultModelId,
          api: "openai-responses",
          tenantId: runtimeAuthTestTenantId,
          ...overrides,
        },
      },
    },
  };
}

function authContext(overrides: Partial<ProviderPrepareRuntimeAuthContext> = {}) {
  const modelId = overrides.modelId ?? "custom-deployment";
  return {
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
    profileId: apiKeyAuth ? "microsoft-foundry:default" : profileId,
    apiKey: apiKeyAuth ? "test-api-key" : "__entra_id_dynamic__",
    endpoint,
    api: "openai-responses",
    authMethod: "entra-id",
    ...params,
  });
}

function builtModel(params: Pick<FoundryAuthParams, "modelId"> & Partial<FoundryAuthParams>) {
  return providerPatch(buildAuthResult(params)).models[0];
}

function builtChatModel(modelId: string, modelNameHint = modelId) {
  return builtModel({ modelId, modelNameHint, api: "openai-completions", authMethod: "api-key" });
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
  const method = registerProvider().auth.find((entry) => entry.id === id);
  assert(method, `expected Foundry ${id} auth method`);
  return method;
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

  it("keeps the API key profile bound when multiple auth profiles exist without explicit order", async () => {
    const config = makeConfig({
      profileIds: ["microsoft-foundry:default", "microsoft-foundry:entra"],
    });
    await selectModel(config, "gpt-5.4");
    expect(config.auth?.order?.["microsoft-foundry"]).toBeUndefined();
  });

  it("tolerates timeout-only provider overlays when selecting a Foundry model", async () => {
    const config = makeConfig({ baseUrl: "", models: [], timeoutSeconds: 120 });
    await selectModel(config, "gpt-5.4");
    expect(configuredProvider(config)).toMatchObject({ models: [], timeoutSeconds: 120 });
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
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "az",
      ["version", "--output", "none"],
      expect.objectContaining({ timeout: 30_000, killSignal: "SIGKILL" }),
    );
  });

  it("fails clearly when the selected Azure subscription is not in the enabled list", async () => {
    mockAzureAccount(["sub-one", "sub-two"]);
    await expect(
      findAuthMethod("entra-id").run(
        authSetup({ select: vi.fn(async () => "missing-subscription") }) as never,
      ),
    ).rejects.toThrow("Selected subscription not found: missing-subscription");
  });

  it("falls back to Entra metadata when a configured Foundry endpoint is malformed", async () => {
    const prepareRuntimeAuth = prepareAuth();
    mockAzureCliToken("test-token-placeholder");
    ensureAuthProfileStoreMock.mockReturnValueOnce(entraStore());
    const prepared = await prepareRuntimeAuth({ model: makeModel({ baseUrl: "not a url" }) });
    expect(extractFoundryEndpoint("not a url")).toBeUndefined();
    expect(prepared).toMatchObject({
      baseUrl,
      request: { auth: { mode: "authorization-bearer", token: "test-token-placeholder" } },
    });
  });

  it.each([
    ["openai-responses", "api-key"],
    ["anthropic-messages", "x-api-key"],
  ] as const)("binds %s API-key auth to the active profile", async (api, headerName) => {
    const prepareRuntimeAuth = prepareAuth();
    const prepared = await prepareRuntimeAuth({
      apiKey: "profile-api-key",
      profileId: "microsoft-foundry:default",
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
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(["--resource", COGNITIVE_SERVICES_RESOURCE]),
    );
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["--scope", FOUNDRY_ANTHROPIC_SCOPE]),
    );
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
      expect(execFileMock).toHaveBeenLastCalledWith(
        "az",
        [
          "account",
          "get-access-token",
          "--resource",
          COGNITIVE_SERVICES_RESOURCE,
          "--output",
          "json",
          "--tenant",
          tenant(0),
        ],
        { logOutput: false, timeoutMs: 30_000 },
      );
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
      const [first, second] = await Promise.all(retries);
      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect([first.apiKey, second.apiKey]).toEqual(["recovered-token", "recovered-token"]);
    } finally {
      // Broken dedupe can consume the recovery response in the first pair.
      failed.release();
      recovery.release();
      await settled;
    }
  });

  it("keeps other configured Foundry models when switching the selected model", async () => {
    const config = makeConfig({
      profileIds: ["microsoft-foundry:default"],
      orderedProfileIds: ["microsoft-foundry:default"],
      models: [
        { ...makeModel({ id: "alias-one" }), api: undefined, baseUrl: undefined },
        { ...makeModel({ id: "alias-two", name: "gpt-4o" }), api: undefined, baseUrl: undefined },
      ],
    });
    await selectModel(config, "alias-one");
    expect(configuredProvider(config).models).toMatchObject([
      { id: "alias-one", input: ["text", "image"] },
      { id: "alias-two" },
    ]);
  });

  it("preserves an explicit per-model Foundry endpoint when switching models", async () => {
    const claudeEndpoint = "https://claude-resource.services.ai.azure.com/anthropic";
    const config = makeConfig({
      models: [
        makeModel({
          id: "prod-fable",
          name: "claude-fable-5",
          api: "anthropic-messages",
          baseUrl: claudeEndpoint,
          reasoning: true,
          input: ["text", "image"],
        }),
      ],
    });
    await selectModel(config, "prod-fable");
    expect(configuredProvider(config)).toMatchObject({
      baseUrl: claudeEndpoint,
      models: [{ baseUrl: claudeEndpoint }],
    });
  });

  it("infers OpenAI routing when adding a GPT deployment from a Claude-configured provider", async () => {
    const config = makeConfig({
      baseUrl: `${endpoint}/anthropic`,
      api: "anthropic-messages",
      models: [],
    });
    await selectModel(config, "gpt-5.4");
    expect(config.models.providers[providerId]).toMatchObject({
      api: "openai-responses",
      baseUrl,
      models: [
        {
          id: "gpt-5.4",
          reasoning: true,
          contextWindow: 1_050_000,
          maxTokens: 128_000,
          compat: { supportsReasoningEffort: true },
          api: "openai-responses",
          baseUrl,
        },
      ],
    });
  });

  it("defaults Azure OpenAI model families to the documented API surfaces", () => {
    expect(usesFoundryResponsesByDefault("gpt-5.4")).toBe(true);
    expect(usesFoundryResponsesByDefault("o4-mini")).toBe(true);
    expect(usesFoundryResponsesByDefault("DeepSeek-V4-Pro")).toBe(true);
    expect(usesFoundryResponsesByDefault("MAI-DS-R1")).toBe(false);
    expect(requiresFoundryMaxCompletionTokens("gpt-5.4")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("o3")).toBe(true);
    expect(requiresFoundryMaxCompletionTokens("gpt-4o")).toBe(false);
    expect(isFoundryMaiImageModel("MAI-Image-2.5-Flash")).toBe(true);
    expect(isFoundryMaiImageModel("MAI-Image-2e")).toBe(true);
    expect(isFoundryMaiImageModel("MAI-DS-R1")).toBe(false);
  });

  it("labels all Foundry API surfaces for onboarding summaries", () => {
    expect(formatFoundryApiLabel("openai-completions")).toBe("Chat Completions");
    expect(formatFoundryApiLabel("openai-responses")).toBe("Responses");
    expect(formatFoundryApiLabel("anthropic-messages")).toBe("Anthropic Messages");
  });

  it("records MAI chat deployments with reasoning-content token limits", () => {
    const model = builtModel({
      modelId: "mai-r1-prod",
      modelNameHint: "MAI-DS-R1",
      api: "openai-completions",
    });
    expect(model).toMatchObject({
      api: "openai-completions",
      reasoning: true,
      contextWindow: 163_840,
      maxTokens: 163_840,
      input: ["text"],
      compat: { supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    });
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
    expect(providerPatch(result).models[0]?.name).toBe("MAI-Image-2.5");
  });

  it("does not reuse stale API-key model metadata when selecting a different deployment", async () => {
    ensureAuthProfileStoreMock.mockReturnValueOnce({
      profiles: {
        "microsoft-foundry:default": {
          type: "api_key",
          provider: "microsoft-foundry",
          metadata: {
            authMethod: "api-key",
            endpoint,
            modelId: "prod-fable",
            modelName: "claude-fable-5",
            api: "anthropic-messages",
          },
        },
      },
    });
    const select = vi.fn(async (params: { initialValue?: string }) => params.initialValue);
    const result = await findAuthMethod("api-key").run({
      ...authSetup({ text: authPrompt("prod-gpt"), select }),
      opts: { azureOpenaiApiKey: "test-api-key" },
      secretInputMode: "plaintext",
    } as never);
    expect(select.mock.calls.map(([params]) => params.initialValue)).toEqual([
      "other-chat",
      "openai-completions",
    ]);
    const model = result?.configPatch?.models?.providers?.["microsoft-foundry"]?.models[0];
    expect(model).toMatchObject({
      id: "prod-gpt",
      name: "prod-gpt",
      api: "openai-completions",
      reasoning: false,
    });
    expect(model?.thinkingLevelMap).toBeUndefined();
  });

  it.each([
    {
      auth: "API key",
      prompt: promptApiKeyEndpointAndModel,
      modelNameHint: "claude-fable-5",
      error: expect.stringContaining("Entra ID auth"),
    },
    {
      auth: "Entra",
      prompt: promptEndpointAndModelManually,
      modelNameHint: "claude-mythos-preview",
      error: undefined,
    },
  ])(
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

  it("preserves explicit capabilities for non-heuristic Foundry aliases", () => {
    expect(normalizeAlias({ input: ["text", "image"] })).toMatchObject({
      name: "production alias",
      reasoning: true,
      input: ["text", "image"],
      compat: { supportsReasoningEffort: true, maxTokensField: "max_completion_tokens" },
    });
  });

  it("preserves explicit reasoning_effort opt-outs for Foundry aliases", () => {
    expect(normalizeAlias({ compat: { supportsReasoningEffort: false } })).toMatchObject({
      reasoning: true,
      compat: { supportsReasoningEffort: false },
    });
  });

  it("keeps replay item ids for Foundry encrypted reasoning continuations", async () => {
    const provider = registerProvider();
    const model = makeModel({ reasoning: true, compat: { supportsStore: false } });
    let capturedReplayIds: boolean | undefined;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      capturedReplayIds = (options as { replayResponsesItemIds?: boolean } | undefined)
        ?.replayResponsesItemIds;
      return {} as never;
    };
    const wrappedStreamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      modelId: "gpt-5.4",
      model,
      extraParams: {},
      config: {},
      agentDir,
    } as never);
    expect(wrappedStreamFn).toBeTypeOf("function");
    await wrappedStreamFn?.(model as never, { systemPrompt: "system", messages: [] } as never, {});
    expect(capturedReplayIds).toBe(true);
  });

  it("leaves Foundry chat completions streams unwrapped by Responses defaults", () => {
    const provider = registerProvider();
    const baseStreamFn: StreamFn = () => ({}) as never;
    expect(
      provider.wrapStreamFn?.({
        streamFn: baseStreamFn,
        modelId: "gpt-4o-mini",
        model: makeModel({
          id: "gpt-4o-mini",
          name: "gpt-4o-mini",
          api: "openai-completions",
        }),
        extraParams: {},
        config: {},
        agentDir,
      } as never),
    ).toBe(baseStreamFn);
  });

  it.each([
    ["gpt-5.6-sol", "openai-responses", "api-key", 1_050_000, 128_000],
    ["gpt-5.4-pro", "openai-responses", "api-key", 1_050_000, 128_000],
    ["gpt-5.4-mini", "openai-responses", "api-key", 400_000, 128_000],
    ["gpt-4o-mini", "openai-completions", "api-key", 128_000, 16_384],
    ["claude-opus-5", "anthropic-messages", "entra-id", 1_000_000, 128_000],
    ["claude-sonnet-4.6", "anthropic-messages", "entra-id", 1_000_000, 128_000],
    ["claude-sonnet-4.5", "anthropic-messages", "entra-id", 200_000, 64_000],
    ["claude-opus-4.1", "anthropic-messages", "entra-id", 200_000, 32_000],
  ] as const)(
    "uses native limits for %s",
    (modelNameHint, api, authMethod, contextWindow, maxTokens) => {
      const model = builtModel({
        modelId: `prod-${modelNameHint}`,
        modelNameHint,
        api,
        authMethod,
      });
      expect(model).toMatchObject({ name: modelNameHint, api, contextWindow, maxTokens });
    },
  );

  it("keeps older Foundry Claude deployments out of Fable-class thinking limits", () => {
    const model = builtModel({
      modelId: "prod-claude-35",
      modelNameHint: "claude-3.5-sonnet",
      api: "anthropic-messages",
    });
    expect(model).toMatchObject({
      id: "prod-claude-35",
      name: "claude-3.5-sonnet",
      api: "anthropic-messages",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 16_384,
    });
    expect(model?.thinkingLevelMap).toBeUndefined();
    expect(model?.compat).toBeUndefined();
  });

  it("resolves Claude thinking profiles from configured Foundry model names", () => {
    const provider = registerProvider();
    const resolve = (canonicalModelId?: string) =>
      provider.resolveThinkingProfile?.({
        provider: providerId,
        modelId: "prod-opaque",
        params: { canonicalModelId },
      });
    const levels = (...ids: string[]) => ids.map((id) => ({ id }));
    const manual = levels("off", "minimal", "low", "medium", "high");
    const adaptive = [...manual, ...levels("adaptive", "max")];
    expect(resolve("claude-opus-5")).toMatchObject({
      defaultLevel: "high",
      levels: levels("off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"),
    });
    expect(resolve("claude-fable-5")).toMatchObject({
      defaultLevel: "medium",
      levels: levels("low", "medium", "high", "xhigh", "max"),
    });
    for (const name of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(resolve(name)).toMatchObject({ defaultLevel: "adaptive", levels: adaptive });
    }
    for (const name of [
      "claude-opus-4-1",
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]) {
      expect(resolve(name)).toMatchObject({ levels: manual });
    }
    expect(resolve()).toBeUndefined();
    expect(resolve("claude-mythos-preview")).toMatchObject({
      defaultLevel: "adaptive",
      levels: levels("minimal", "low", "medium", "high", "adaptive"),
    });
  });

  it.each([
    [
      "deployment-codex-mini",
      "gpt-5.1-codex-mini",
      {
        reasoning: true,
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "medium", "high"],
          maxTokensField: "max_completion_tokens",
        },
      },
      {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
    ],
    [
      "gpt-5-codex",
      "gpt-5-codex",
      {
        thinkingLevelMap: { minimal: null },
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
      },
      undefined,
    ],
    [
      "gpt-5-chat",
      "gpt-5-chat",
      {
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsReasoningEffort: false, maxTokensField: "max_completion_tokens" },
      },
      undefined,
    ],
  ] as const)("records reasoning metadata for %s", (modelId, modelNameHint, expected, thinking) => {
    const model = builtChatModel(modelId, modelNameHint);
    expect(model).toMatchObject(expected);
    // Persisted maps use schema level keys (openclaw#91011).
    if (thinking) {
      expect(model?.thinkingLevelMap).toEqual(thinking);
    }
  });

  it("preserves project-scoped endpoint prefixes when extracting the Foundry endpoint", async () => {
    mockAzureCliToken("test-token-placeholder");
    ensureAuthProfileStoreMock.mockReturnValueOnce({ profiles: {} });
    const prepared = await prepareAuth()({
      modelId: "deployment-gpt5",
      model: makeModel({
        id: "deployment-gpt5",
        baseUrl: "https://example.services.ai.azure.com/api/projects/demo/openai/v1/responses",
      }),
    });
    expect(prepared?.baseUrl).toBe(
      "https://example.services.ai.azure.com/api/projects/demo/openai/v1",
    );
  });

  it("keeps bounded Azure CLI error details UTF-16 safe", async () => {
    const prefix = "x".repeat(299);
    execFileMock.mockRejectedValueOnce(
      Object.assign(new Error("az failed"), { stderr: `${prefix}😀tail`, stdout: "" }),
    );
    await expect(getAccessTokenResultAsync()).rejects.toMatchObject({
      message: `az failed: ${prefix}`,
    });
  });

  it("deletes legacy provider-level secret refs", () => {
    const result = buildAuthResult({
      apiKey: { source: "env", provider: "default", id: "AZURE_OPENAI_API_KEY" },
      modelId: "gpt-4o",
      authMethod: "api-key",
    });
    const provider = providerPatch(result);
    for (const key of ["apiKey", "authHeader", "headers"] as const) {
      expect(provider[key]).toBeUndefined();
      expect(Object.hasOwn(provider, key)).toBe(true);
    }
  });

  it("moves the selected Foundry auth profile to the front of auth.order", () => {
    const result = buildAuthResult({
      modelId: "gpt-5.4",
      currentProviderProfileIds: ["microsoft-foundry:default", "microsoft-foundry:entra"],
    });
    expect(result.configPatch?.auth?.order?.[providerId]).toEqual([
      profileId,
      "microsoft-foundry:default",
    ]);
  });

  it("persists discovered deployments alongside the selected default model", () => {
    const result = buildAuthResult({
      modelId: "deployment-gpt5",
      modelNameHint: "gpt-5.4",
      deployments: [
        { name: "deployment-gpt5", modelName: "gpt-5.4", api: "openai-responses" },
        { name: "deployment-gpt4o", modelName: "gpt-4o", api: "openai-responses" },
        { name: "deployment-fable", modelName: "claude-fable-5", api: "anthropic-messages" },
      ],
    });
    const provider = providerPatch(result);
    expect(provider?.models.map((model) => [model.id, model.baseUrl])).toEqual([
      ["deployment-gpt5", baseUrl],
      ["deployment-gpt4o", baseUrl],
      ["deployment-fable", `${endpoint}/anthropic`],
    ]);
    expect(result.defaultModel).toBe("microsoft-foundry/deployment-gpt5");
    expect(provider.models[0]).toMatchObject({
      input: ["text", "image"],
      compat: { supportsStore: false, maxTokensField: "max_completion_tokens" },
    });
  });
});

describe("selectFoundryDeployment", () => {
  function makeCtx(overrides: { selectValue?: string } = {}) {
    const note = vi.fn(async (_message: string, _title: string) => {});
    const select = vi.fn(
      async (params: { options: Array<{ value: string }> }) =>
        overrides.selectValue ?? params.options[0]?.value,
    );
    return { ctx: { prompter: { note, select } } as never, note, select };
  }

  const fakeResource = {
    id: "/sub/x/rg/y/account/z",
    accountName: "foundry-resource",
    kind: "AIServices" as const,
    resourceGroup: "rg",
    endpoint,
    projects: [],
  };

  it("offers and returns Claude deployments alongside GPT resources", async () => {
    const { ctx, select, note } = makeCtx({ selectValue: "prod-mini" });
    const names = ["prod-gpt", "prod-claude", "prod-mini"];
    const result = await selectFoundryDeployment(ctx, fakeResource, [
      { name: "prod-gpt", modelName: "gpt-5.4", state: "Succeeded" },
      { name: "prod-claude", modelName: "claude-opus-4-6", state: "Succeeded" },
      { name: "prod-mini", modelName: "gpt-4o-mini", state: "Succeeded" },
    ]);
    expect(result.supported.map((deployment) => deployment.name)).toEqual(names);
    expect(result.selected.name).toBe("prod-mini");
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0]?.[0].options.map((option) => option.value)).toEqual(names);
    expect(note.mock.calls.some(([, title]) => title === "Unsupported Deployments")).toBe(false);
  });

  it("uses Anthropic-only deployment resources directly", async () => {
    const { ctx, note } = makeCtx();
    const deployment = { name: "only-claude", modelName: "claude-3.5-sonnet", state: "Succeeded" };
    const result = await selectFoundryDeployment(ctx, fakeResource, [deployment]);
    expect(result).toEqual({ selected: deployment, supported: [deployment] });
    expect(note.mock.calls.some(([, title]) => title === "Unsupported Deployments")).toBe(false);
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
