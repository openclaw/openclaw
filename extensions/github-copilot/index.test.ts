import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runGitHubCopilotDeviceFlow } from "./login.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<typeof fetchWithSsrFGuard>(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  })),
  resolveCopilotRuntimeAuth: vi.fn(),
  resolveCopilotStarterModel: vi.fn(async () => "github-copilot/claude-sonnet-5"),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

vi.mock("./register.runtime.js", () => ({
  DEFAULT_COPILOT_API_BASE_URL: "https://api.githubcopilot.test",
  resolveCopilotRuntimeAuth: mocks.resolveCopilotRuntimeAuth,
  resolveCopilotStarterModel: mocks.resolveCopilotStarterModel,
  fetchCopilotUsage: vi.fn(),
}));

import plugin from "./index.js";
import {
  interactiveContext,
  registerProviderWithPluginConfig,
  requireAuthMethod,
} from "./provider.test-support.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.fetchWithSsrFGuard.mockImplementation(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  }));
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

async function runDeviceAuthWithFakeTimers<T>(
  run: (openUrl: (url: string) => Promise<void>) => T | Promise<T>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    let notifyDeviceCodeShown!: () => void;
    const deviceCodeShown = new Promise<void>((resolve) => {
      notifyDeviceCodeShown = resolve;
    });
    const pending = Promise.resolve(run(async () => notifyDeviceCodeShown()));
    const openedBeforeCompletion = await Promise.race([
      deviceCodeShown.then(() => true),
      pending.then(() => false),
    ]);
    expect(openedBeforeCompletion).toBe(true);
    // Browser handoff follows the profile, device-code, and prompt work.
    await vi.advanceTimersByTimeAsync(1_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

async function createAgentDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-copilot-test-"));
  tempDirs.push(dir);
  return dir;
}

function createModelRegistry() {
  return {
    getAll: vi.fn(() => []),
    getAvailable: vi.fn(() => []),
    find: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn(() => false),
  };
}

const tokenProfile = (token: string) => ({
  type: "token" as const,
  provider: "github-copilot",
  token,
});
const oauthProfile = (enterpriseUrl?: string) => ({
  type: "oauth" as const,
  provider: "github-copilot",
  access: "short-lived-copilot-token",
  refresh: "durable-github-token",
  expires: Date.now() + 60_000,
  ...(enterpriseUrl ? { enterpriseUrl } : {}),
});
const copilotConfig = <T>(settings: T) => ({
  models: { providers: { "github-copilot": settings } },
});
const authMethod = (index = 0) =>
  requireAuthMethod(registerProviderWithPluginConfig({}).auth, index);
const flagKey = (key: string) => vi.fn(async () => ({ key, source: "flag" as const }));
const loginPrompter = (domain: string) => ({
  confirm: vi.fn(async () => false),
  text: vi.fn(async () => domain),
  note: vi.fn(async (_message: string, _title?: string) => {}),
});
async function authFixture(index = 0) {
  return {
    method: authMethod(index),
    agentDir: await createAgentDir(),
    runtime: { error: vi.fn(), exit: vi.fn() },
  };
}
const mockRuntimeAuth = (apiKey: string, baseUrl: string) =>
  mocks.resolveCopilotRuntimeAuth.mockResolvedValue({ apiKey, baseUrl });
function mockCatalog(data: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data })),
  );
}
function visibleModel(
  id: string,
  name: string,
  enabled = true,
  state = "enabled",
  streaming = true,
) {
  return {
    id,
    name,
    model_picker_enabled: enabled,
    policy: { state },
    capabilities: { type: "chat", supports: { streaming, tool_calls: streaming } },
  };
}
const chatModel = (
  id: string,
  capabilities: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
) => ({ id, ...metadata, capabilities: { type: "chat", ...capabilities } });
function catalogResponse(
  contextWindow: number,
  promptTokens: number,
  supports?: Record<string, unknown>,
) {
  return Response.json({
    data: [
      chatModel(
        "gpt-5.6-sol",
        {
          limits: {
            max_context_window_tokens: contextWindow,
            max_prompt_tokens: promptTokens,
            max_output_tokens: 128_000,
          },
          ...(supports ? { supports } : {}),
        },
        { name: "GPT-5.6 Sol", object: "model", vendor: "OpenAI" },
      ),
    ],
  });
}

function writeProfiles(
  agentDir: string,
  profiles: Parameters<typeof saveAuthProfileStore>[0]["profiles"],
) {
  saveAuthProfileStore({ version: 1, profiles }, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

function writeExistingCopilotTokenProfile(agentDir: string) {
  writeProfiles(agentDir, {
    "github-copilot:github": tokenProfile("existing-token"),
  });
}

function nonInteractiveContext(agentDir: string) {
  return {
    authChoice: "github-copilot",
    config: {},
    baseConfig: {},
    opts: {},
    agentDir,
    toApiKeyCredential: vi.fn(),
  };
}

async function onboard(token: string | undefined, overrides: Record<string, unknown> = {}) {
  const { method, agentDir, runtime } = await authFixture();
  return {
    agentDir,
    runtime,
    run: () =>
      method.runNonInteractive({
        ...nonInteractiveContext(agentDir),
        runtime,
        opts: token ? { githubCopilotToken: token } : {},
        resolveApiKey: token ? flagKey(token) : vi.fn(async () => null),
        ...overrides,
      }),
  };
}

const storedToken = (token: string) => ({
  profileId: "github-copilot:github",
  credential: tokenProfile(token),
  secretStorage: { kind: "store", namePrefix: "GITHUB_COPILOT_TOKEN" },
});

describe("github-copilot plugin", () => {
  it("registers embedding provider", () => {
    const registerEmbeddingProviderMock = vi.fn<OpenClawPluginApi["registerEmbeddingProvider"]>();

    plugin.register(
      createTestPluginApi({
        id: "github-copilot",
        name: "GitHub Copilot",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerProvider: vi.fn(),
        registerEmbeddingProvider: registerEmbeddingProviderMock,
      }),
    );

    expect(registerEmbeddingProviderMock).toHaveBeenCalledTimes(1);
    const adapter = expectDefined(
      registerEmbeddingProviderMock.mock.calls[0]?.[0],
      "embedding provider registration",
    );
    expect(adapter.id).toBe("github-copilot");
  });

  it("normalizes legacy OAuth profiles without losing tenant metadata", async () => {
    const provider = registerProviderWithPluginConfig({});
    const credential = { ...oauthProfile("acme.ghe.com"), expires: 1 };
    const before = { ...credential };

    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
      ...credential,
      access: "durable-github-token",
      expires: MAX_DATE_TIMESTAMP_MS,
    });
    expect(credential).toEqual(before);
  });

  it("rejects unsafe legacy OAuth tenants before formatting or refresh", async () => {
    const provider = registerProviderWithPluginConfig({});
    const credential = { ...oauthProfile("attacker.example"), expires: 1 };

    expect(() => provider.formatApiKey?.(credential)).toThrow(/attacker\.example/);
    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow(/attacker\.example/);
  });

  it("moves unsupported legacy OAuth doctor guidance into the provider", async () => {
    const provider = registerProviderWithPluginConfig({});
    const store = {
      version: 1,
      profiles: {
        "github-copilot:default": oauthProfile("attacker.example"),
      },
    };

    const hint = () =>
      provider.buildAuthDoctorHint?.({
        store,
        provider: "github-copilot",
        profileId: "github-copilot:default",
      });
    expect(await hint()).toContain("unsupported enterprise domain");
    store.profiles["github-copilot:default"].enterpriseUrl = "acme.ghe.com";
    expect(await hint()).toBeUndefined();
  });

  it("rejects an unresolved integration SecretRef before catalog fallback or inference", async () => {
    const provider = registerProviderWithPluginConfig({});
    const agentDir = await createAgentDir();
    const config = copilotConfig({
      request: {
        headers: {
          "Copilot-Integration-Id": { source: "env", provider: "default", id: "IDENTITY" },
        },
      },
    });
    mockRuntimeAuth("github-source-token", "https://copilot-api.acme.ghe.com");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      provider.catalog.run({
        agentDir,
        config,
        env: { COPILOT_GITHUB_TOKEN: "github-source-token" },
      }),
    ).rejects.toMatchObject({ name: "UnresolvedSecretInputError" });
    const streamFn = vi.fn();
    const model = { id: "claude-sonnet-5", provider: "github-copilot", api: "openai-responses" };
    for (const wrap of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
      const wrapped = wrap?.({ config, streamFn } as never);
      expect(() => wrapped?.(model as never, { messages: [] }, {})).toThrow(
        expect.objectContaining({ name: "UnresolvedSecretInputError" }),
      );
    }
    expect(streamFn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps configured headers in runtime auth and sends identity through stream wrappers", async () => {
    const provider = registerProviderWithPluginConfig({});
    mocks.resolveCopilotRuntimeAuth.mockResolvedValue({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const prepare = (headers?: Record<string, string>) =>
      provider.prepareRuntimeAuth({
        config: {},
        env: {},
        provider: "github-copilot",
        modelId: "gpt-5.4-mini",
        model: { id: "gpt-5.4-mini", provider: "github-copilot", headers },
        apiKey: "github-source-token",
        authMode: "token",
      } as never);

    // Runtime auth output is sealed and registered for redaction: configured
    // headers stay there, while public identity values must not.
    await expect(prepare()).resolves.toEqual({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    await expect(prepare({ "X-Opaque": "inline-header-credential" })).resolves.toEqual({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      request: { headers: { "X-Opaque": "inline-header-credential" } },
    });

    const streamFn = vi.fn();
    const wrapped = provider.wrapSimpleCompletionStreamFn?.({ config: {}, streamFn } as never);
    void wrapped?.(
      {
        id: "gpt-5.4-mini",
        provider: "github-copilot",
        api: "openai-completions",
        headers: { "X-Custom": "kept" },
      } as never,
      { messages: [] },
      {},
    );
    expect(streamFn.mock.calls[0]?.[2]?.headers).toMatchObject({
      "Openai-Organization": "github-copilot",
      "Copilot-Integration-Id": "copilot-developer-cli",
      "X-Custom": "kept",
    });
  });

  it("isolates live catalog results by the configured integration header", async () => {
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const provider = registerProviderWithPluginConfig({});
    const modelRegistry = createModelRegistry();
    mockRuntimeAuth("identity-catalog-token", "https://copilot-api.acme.ghe.com");
    const observedHeaders: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        const headers = new Headers(init?.headers);
        observedHeaders.push(headers);
        return Response.json({
          data: [
            {
              id: "gpt-5-mini",
              model_picker_enabled: true,
              policy: { state: "enabled" },
              capabilities: {
                type: "chat",
                supports: { streaming: true, tool_calls: true },
                limits: {
                  max_context_window_tokens:
                    headers.get("copilot-integration-id") === "vscode-chat" ? 100_000 : 200_000,
                },
              },
            },
          ],
        });
      }),
    );

    for (const identity of ["vscode-chat", "copilot-developer-cli"]) {
      const config = copilotConfig({
        baseUrl: "https://copilot-api.acme.ghe.com",
        models: [],
        headers: {
          "copilot-integration-id": identity,
          "X-Private-Header": "not-for-catalog",
        },
      });
      const result = await provider.catalog.run({
        agentDir,
        env: { COPILOT_GITHUB_TOKEN: "identity-catalog-token" },
        config,
      });
      const contextWindow = identity === "vscode-chat" ? 100_000 : 200_000;
      expect(result && "provider" in result ? result.provider.models : []).toMatchObject([
        { id: "gpt-5-mini", contextWindow },
      ]);
      const context = {
        config,
        agentDir,
        modelRegistry,
        provider: "github-copilot",
        modelId: "gpt-5-mini",
        authProfileId: "github-copilot:github",
      };
      await provider.prepareDynamicModel(context);
      expect(provider.resolveDynamicModel(context)).toMatchObject({
        id: "gpt-5-mini",
        contextWindow,
      });
    }
    expect(observedHeaders).toHaveLength(2);
    expect(observedHeaders.every((headers) => !headers.has("x-private-header"))).toBe(true);
  });

  it.each([
    {
      label: "a public OAuth account with stale enterprise configuration",
      profile: oauthProfile(),
      expectedDomain: "github.com",
    },
    {
      label: "an enterprise OAuth account with an explicit environment domain",
      profile: oauthProfile("acme.ghe.com"),
      expectedDomain: "override.ghe.com",
      envDomain: "override.ghe.com",
    },
  ])("uses $label when discovering its live Copilot model catalog", async (testCase) => {
    const agentDir = await createAgentDir();
    writeProfiles(agentDir, {
      "github-copilot:first": tokenProfile("first-token"),
      "github-copilot:preferred": testCase.profile,
    });
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "preferred-copilot-token",
      baseUrl: "https://api.githubcopilot.preferred",
    });
    const entry = visibleModel("gpt-5.4", "GPT-5.4");
    mockCatalog([
      {
        ...entry,
        capabilities: {
          ...entry.capabilities,
          limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
        },
      },
    ]);
    const provider = registerProviderWithPluginConfig({});

    const env = testCase.envDomain ? { COPILOT_GITHUB_DOMAIN: testCase.envDomain } : {};
    const result = await provider.catalog.run({
      config: {
        auth: { order: { "github-copilot": ["github-copilot:preferred"] } },
        ...copilotConfig({
          baseUrl: "https://api.githubcopilot.com",
          models: [],
          params: { githubDomain: "other.ghe.com" },
        }),
      },
      agentDir,
      env,
    });

    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledWith({
      githubToken: "durable-github-token",
      env,
      githubDomain: testCase.expectedDomain,
    });
    expect(
      result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
    ).toEqual(["gpt-5.4"]);
  });

  it.each(["GITHUB_TOKEN"])("ignores %s during catalog discovery", async (key) => {
    const provider = registerProviderWithPluginConfig({});
    const agentDir = await createAgentDir();
    const result = await provider.catalog.run({
      config: {},
      agentDir,
      env: { [key]: "generic-token" },
    });
    expect(result).toBeNull();
    expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
  });

  it("does not exchange auth or discover models for an unavailable direct SecretRef", async () => {
    const agentDir = await createAgentDir();
    const provider = registerProviderWithPluginConfig({});

    await expect(
      provider.catalog.run({
        config: copilotConfig({
          apiKey: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_MISSING_COPILOT_CATALOG_TOKEN",
          },
        }),
        agentDir,
        env: { COPILOT_GITHUB_TOKEN: "ambient-token" },
      }),
    ).rejects.toThrow("models.providers.github-copilot.apiKey");

    expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
    expect(mocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("exposes xhigh and max thinking for the bundled Claude Opus 5 model", () => {
    const provider = registerProviderWithPluginConfig({});
    const model = expectDefined(
      manifest.modelCatalog.providers["github-copilot"].models.find(
        (candidate) => candidate.id === "claude-opus-5",
      ),
      "bundled GitHub Copilot Claude Opus 5 model",
    );

    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId: model.id,
      compat: model.compat,
    });

    expect(profile?.levels.map((level) => level.id)).toEqual(
      expect.arrayContaining(["xhigh", "max"]),
    );
  });

  it.each([
    { modelId: "gpt-5.4-mini", efforts: ["none", "low", "medium", "high", "xhigh"], xhigh: true },
    { modelId: "gpt-5-mini", efforts: ["low", "medium", "high"], xhigh: false },
  ])("gates non-Claude $modelId xhigh on catalog effort", ({ modelId, efforts, xhigh }) => {
    const provider = registerProviderWithPluginConfig({});
    const profile = provider.resolveThinkingProfile({
      provider: "github-copilot",
      modelId,
      compat: { supportedReasoningEfforts: efforts },
    });
    expect(profile).toBeDefined();
    expect(profile?.levels.some((level) => level.id === "xhigh") ?? false).toBe(xhigh);
  });

  it("publishes only picker-visible, policy-enabled tool models in the live catalog", async () => {
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "catalog-policy-token",
      baseUrl: "https://api.githubcopilot.policy-test",
    });
    const eligible = visibleModel("eligible", "Eligible");
    mockCatalog([
      {
        ...eligible,
        model_picker_category: "versatile",
        capabilities: {
          ...eligible.capabilities,
          limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
        },
      },
      visibleModel("disabled", "Disabled", true, "disabled"),
      visibleModel("hidden", "Hidden", false),
      visibleModel("chat-only", "Chat only", true, "enabled", false),
    ]);
    const provider = registerProviderWithPluginConfig({});

    const result = await provider.catalog.run({
      config: {},
      agentDir: "/tmp/agent",
      env: { COPILOT_GITHUB_TOKEN: "catalog-source-token" },
    } as never);

    expect(
      result && "provider" in result ? result.provider.models.map((model) => model.id) : [],
    ).toEqual(["eligible", "chat-only"]);
  });

  it.each([
    { stage: "user", status: 503, expected: "unavailable" },
    { stage: "models", status: 503, expected: "unavailable" },
  ])(
    "records the catalog attempt at $stage with HTTP $status",
    async ({ stage, status, expected }) => {
      const agentDir = await createAgentDir();
      writeExistingCopilotTokenProfile(agentDir);
      const provider = registerProviderWithPluginConfig({});
      mocks.resolveCopilotRuntimeAuth.mockReset();
      if (stage === "user") {
        mocks.resolveCopilotRuntimeAuth.mockRejectedValue(
          new CopilotRuntimeAuthError({ reason: "http_error", status }),
        );
      } else {
        mocks.resolveCopilotRuntimeAuth.mockResolvedValue({
          apiKey: "catalog-attempt-token",
          baseUrl: `https://api.githubcopilot.attempt-${status}`,
        });
      }
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [] }, { status }));
      vi.stubGlobal("fetch", fetchMock);
      const result = await provider.catalog.run({ config: {}, agentDir, env: {} });
      expect(result?.outcomes).toEqual([
        {
          provider: "github-copilot",
          profileId: "github-copilot:github",
          status: expected,
        },
      ]);
      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledTimes(stage === "user" ? 0 : 1);
      expect(result && "providers" in result ? result.providers : undefined).toEqual({});
    },
  );

  it.each([true, false])(
    "returns a supplied token with credentialOnly=%s without replacing stored credentials or starting login",
    async (credentialOnly) => {
      const method = authMethod();
      const agentDir = await createAgentDir();
      writeExistingCopilotTokenProfile(agentDir);
      const before = structuredClone(ensureAuthProfileStore(agentDir));
      const prompter = { confirm: vi.fn(), note: vi.fn(), text: vi.fn() };
      const openUrl = vi.fn();

      const result = await method.run({
        ...interactiveContext(agentDir),
        credentialOnly,
        prompter,
        opts: { tokenProvider: "github-copilot", token: "supplied-setup-token" },
        isRemote: true,
        openUrl,
        existingProfiles: undefined,
      });

      expect(result).toMatchObject({
        profiles: [storedToken("supplied-setup-token")],
      });
      if (credentialOnly) {
        expect(result?.defaultModel).toBeUndefined();
      } else {
        expect(result?.defaultModel).toBeTruthy();
      }
      expect(ensureAuthProfileStore(agentDir)).toEqual(before);
      expect(prompter.confirm).not.toHaveBeenCalled();
      expect(prompter.text).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
      expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
      expect(mocks.resolveCopilotStarterModel).not.toHaveBeenCalled();
    },
  );

  it("keeps valid interactive auth when live starter-model discovery is unavailable", async () => {
    mocks.resolveCopilotStarterModel.mockRejectedValueOnce(new Error("catalog unavailable"));
    const method = authMethod();
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);

    const result = await method.run({
      ...interactiveContext(agentDir),
      prompter: {
        confirm: vi.fn(async () => false),
        note: vi.fn(),
      },
      secretInputMode: "plaintext",
      openUrl: vi.fn(),
    } as never);

    expect(result).toMatchObject({
      profiles: [
        { profileId: "github-copilot:github", credential: tokenProfile("existing-token") },
      ],
      notes: [expect.stringContaining("authentication succeeded")],
    });
    expect(result?.defaultModel).toBeUndefined();
  });

  it.each([
    {
      fallback: false,
      title: "uses account-scoped live metadata",
      tokens: ["chosen", "first"],
      hosts: ["live", "first"],
      limits: [
        [1_050_000, 922_000],
        [400_000, 272_000],
      ],
    },
    {
      fallback: true,
      title: "rematerializes direct metadata after profile fallback",
      tokens: ["test-auth-token", "test-token-placeholder"],
      hosts: ["profile", "direct"],
      limits: [
        [200_000, 150_000],
        [1_050_000, 922_000],
      ],
    },
  ])("$title for request-time resolution", async ({ fallback, tokens, hosts, limits }) => {
    const agentDir = await createAgentDir();
    writeProfiles(agentDir, {
      "github-copilot:first": tokenProfile(fallback ? tokens[0]! : tokens[1]!),
      ...(!fallback ? { "github-copilot:selected": tokenProfile(tokens[0]!) } : {}),
    });
    const supports = fallback
      ? undefined
      : {
          vision: true,
          reasoning_effort: ["none", "low", "medium", "high", "xhigh"],
        };
    const fetchMock = vi.fn();
    for (const [index, token] of tokens.entries()) {
      mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
        apiKey: token,
        baseUrl: `https://api.githubcopilot.${hosts[index]}`,
      });
      const [contextWindow, promptTokens] = limits[index]!;
      fetchMock.mockResolvedValueOnce(catalogResponse(contextWindow!, promptTokens!, supports));
    }
    vi.stubGlobal("fetch", fetchMock);
    const provider = registerProviderWithPluginConfig({});
    const first = {
      config: fallback
        ? (copilotConfig({
            apiKey: tokens[1],
            baseUrl: "https://api.githubcopilot.test",
            models: [],
          }) as OpenClawConfig)
        : {},
      agentDir,
      provider: "github-copilot",
      modelId: "gpt-5.6-sol",
      modelRegistry: createModelRegistry(),
      authProfileId: fallback ? "github-copilot:first" : "github-copilot:selected",
    } as Parameters<typeof provider.prepareDynamicModel>[0];
    const second = {
      ...first,
      authProfileId: fallback ? undefined : "github-copilot:first",
      ...(fallback ? { authProfileMode: "api_key" as const } : {}),
    };
    // Prepare both before reading either to catch account metadata leaking across fallback.
    await provider.prepareDynamicModel(first);
    await provider.prepareDynamicModel(second);
    if (!fallback) {
      expect(provider.preferRuntimeResolvedModel(first)).toBe(true);
    }
    for (const [index, context] of [first, second].entries()) {
      expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenNthCalledWith(index + 1, {
        githubToken: tokens[index],
        env: process.env,
        githubDomain: "github.com",
      });
      expect(provider.resolveDynamicModel(context)).toMatchObject({
        ...(!fallback ? { id: "gpt-5.6-sol", provider: "github-copilot", maxTokens: 128_000 } : {}),
        baseUrl: `https://api.githubcopilot.${hosts[index]}`,
        contextWindow: limits[index]![0],
        contextTokens: limits[index]![1],
      });
    }
  });

  function buildDeviceFlowFetchMock(domain: string, accessToken: string) {
    return vi.fn(async (input: unknown, _init?: RequestInit) => {
      const target =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input instanceof Request
              ? input.url
              : String(input);
      if (target === `https://${domain}/login/device/code`) {
        return Response.json({
          device_code: "device-code-stub",
          user_code: "ABCD-1234",
          verification_uri: `https://${domain}/login/device`,
          expires_in: 900,
          interval: 0,
        });
      }
      if (target === `https://${domain}/login/oauth/access_token`) {
        return Response.json({ access_token: accessToken, token_type: "bearer" });
      }
      throw new Error(`unexpected fetch in github-copilot device flow test: ${target}`);
    });
  }

  it("threads provider authority into the guarded device request", async () => {
    const method = authMethod();
    const agentDir = await createAgentDir();
    let current = true;
    const dispatch = vi.fn();
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      await Promise.resolve();
      current = false;
      params.beforeRequest?.();
      dispatch();
      throw new Error("Request dispatched after authority was revoked");
    });

    await expect(
      method.run({
        ...interactiveContext(agentDir),
        credentialOnly: true,
        prompter: { confirm: vi.fn(), note: vi.fn() },
        isRemote: true,
        openUrl: vi.fn(),
        existingProfiles: undefined,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Login revoked");
          }
        },
      }),
    ).rejects.toThrow("Login revoked");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { methodIndex: 1, domain: "acme.ghe.com", existing: false, credentialOnly: true },
    { methodIndex: 0, domain: "github.com", existing: true, credentialOnly: false },
  ])(
    "starts fresh $domain login with stored=$existing, credentialOnly=$credentialOnly",
    async ({ methodIndex, domain, existing, credentialOnly }) => {
      const method = authMethod(methodIndex);
      const agentDir = await createAgentDir();
      if (existing) {
        writeExistingCopilotTokenProfile(agentDir);
      }
      const fetchMock = buildDeviceFlowFetchMock(domain, "connected-token");
      mocks.fetchWithSsrFGuard.mockImplementation(async (params) => ({
        response: await fetchMock(params.url, params.init),
        finalUrl: params.url,
        release: async () => {},
      }));
      const prompter = {
        confirm: vi.fn(async () => {
          throw new Error("Login must not offer unauthorized stored credentials");
        }),
        text: vi.fn(async () => domain),
        note: vi.fn(),
      };
      const result = await runDeviceAuthWithFakeTimers((openUrl) =>
        method.run({
          ...interactiveContext(agentDir),
          credentialOnly,
          prompter,
          isRemote: true,
          openUrl,
          existingProfiles: undefined,
        }),
      );

      expect(result?.profiles).toEqual([storedToken("connected-token")]);
      expect(result?.defaultModel).toBe(
        credentialOnly ? undefined : "github-copilot/claude-sonnet-5",
      );
      expect(mocks.resolveCopilotStarterModel).toHaveBeenCalledTimes(credentialOnly ? 0 : 1);
      expect(result?.configPatch).toEqual(
        methodIndex === 1 ? copilotConfig({ params: { githubDomain: domain } }) : undefined,
      );
      expect(prompter.confirm).not.toHaveBeenCalled();
      expect(prompter.text).toHaveBeenCalledTimes(methodIndex);
      expect(mocks.resolveCopilotRuntimeAuth).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("forces re-login and clears the domain when switching from a tenant back to github.com", async () => {
    const method = authMethod();
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const fetchMock = buildDeviceFlowFetchMock("github.com", "public-fresh-token");
    vi.stubGlobal("fetch", fetchMock);
    const prompter = loginPrompter("");

    const result = await runDeviceAuthWithFakeTimers((openUrl) =>
      method.run({
        ...interactiveContext(agentDir),
        config: copilotConfig({ params: { githubDomain: "acme.ghe.com" } }),
        prompter,
        openUrl,
      } as never),
    );

    expect(prompter.confirm).not.toHaveBeenCalled();
    const deviceNote = prompter.note.mock.calls.find(
      ([, title]) => title === "Authorize GitHub Copilot",
    );
    expect(deviceNote).toBeDefined();
    const [message] = expectDefined(deviceNote, "device-code note");
    expect(markdownToIR(message, { linkify: false }).links.map((link) => link.href)).toEqual([
      "https://github.com/login/device",
    ]);
    expect(message).toContain("\nCode: ABCD-1234\n");
    expect(result?.profiles[0]).toEqual(storedToken("public-fresh-token"));
    const params = result?.configPatch?.models?.providers?.["github-copilot"]?.params;
    expect(params && Object.hasOwn(params, "githubDomain")).toBe(true);
    expect(params?.githubDomain).toBeUndefined();
  });

  it("forces re-login when an existing public profile meets an env-only tenant domain", async () => {
    const method = authMethod(1);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    // Compare against persisted github.com, not the env-selected tenant.
    const fetchMock = buildDeviceFlowFetchMock("acme.ghe.com", "tenant-fresh-token");
    vi.stubGlobal("fetch", fetchMock);
    const prompter = loginPrompter("typed-tenant.ghe.com");

    const result = await runDeviceAuthWithFakeTimers((openUrl) =>
      method.run({
        ...interactiveContext(agentDir),
        env: { COPILOT_GITHUB_DOMAIN: "acme.ghe.com" },
        prompter,
        secretInputMode: "plaintext",
        openUrl,
      } as never),
    );
    expect(prompter.text).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(result?.profiles[0]?.credential).toEqual(tokenProfile("tenant-fresh-token"));
    const params = result?.configPatch?.models?.providers?.["github-copilot"]?.params;
    expect(params?.githubDomain).toBe("acme.ghe.com");
  });

  it("reuses the host-authorized token reference for the same enterprise tenant", async () => {
    const method = authMethod(1);
    const agentDir = await createAgentDir();
    writeExistingCopilotTokenProfile(agentDir);
    const authorizedProfile: ProviderAuthResult["profiles"][number] = {
      profileId: "github-copilot:authorized",
      credential: {
        type: "token",
        provider: "github-copilot",
        tokenRef: { source: "env", provider: "default", id: "AUTHORIZED_COPILOT_TOKEN" },
      },
    };
    const prompter = loginPrompter("acme.ghe.com");

    const result = await method.run({
      ...interactiveContext(agentDir),
      env: { AUTHORIZED_COPILOT_TOKEN: "authorized-token" },
      existingProfiles: [authorizedProfile],
      config: copilotConfig({ params: { githubDomain: "acme.ghe.com" } }),
      prompter,
      secretInputMode: "plaintext",
      openUrl: vi.fn(),
    } as never);
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "GitHub Copilot auth already exists. Re-run login?",
      initialValue: false,
    });
    expect(result?.profiles).toEqual([authorizedProfile]);
    expect(mocks.resolveCopilotStarterModel).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "authorized-token", githubDomain: "acme.ghe.com" }),
    );
    expect(result?.configPatch?.models?.providers?.["github-copilot"]?.params?.githubDomain).toBe(
      "acme.ghe.com",
    );
  });

  it("rejects unsafe GitHub device code lifetimes before polling", async () => {
    const release = vi.fn(async () => {});
    mocks.fetchWithSsrFGuard.mockImplementation(async () => ({
      response: new Response(
        '{"device_code":"device-code-stub","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":1e309,"interval":0}',
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      finalUrl: "https://github.com/login/device/code",
      release,
    }));

    const showCode = vi.fn();
    await expect(runGitHubCopilotDeviceFlow({ showCode })).rejects.toThrow(
      "GitHub device code response missing fields",
    );
    expect(showCode).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not persist a new token when non-interactive starter-model discovery fails", async () => {
    mocks.resolveCopilotStarterModel.mockRejectedValueOnce(new Error("no eligible models"));
    const { agentDir, run } = await onboard("ghu_invalid_for_catalog");
    await expect(run()).rejects.toThrow("no eligible models");
    expect(ensureAuthProfileStore(agentDir).profiles["github-copilot:github"]).toBeUndefined();
  });

  it("persists COPILOT_GITHUB_DOMAIN during non-interactive onboarding", async () => {
    vi.stubEnv("COPILOT_GITHUB_DOMAIN", "acme.ghe.com");
    const { agentDir, runtime, run } = await onboard("ghu_test123");
    const result = await run();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.models?.providers?.["github-copilot"]?.params?.githubDomain).toBe(
      "acme.ghe.com",
    );
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });

    expect(ensureAuthProfileStore(agentDir).profiles["github-copilot:github"]).toEqual(
      tokenProfile("ghu_test123"),
    );
  });

  it("clears a persisted enterprise domain during public non-interactive onboarding", async () => {
    vi.stubEnv("COPILOT_GITHUB_DOMAIN", "github.com");
    const { runtime, run } = await onboard("ghu_public", {
      config: copilotConfig({ params: { githubDomain: "acme.ghe.com" } }),
    });
    const result = await run();

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.models?.providers?.["github-copilot"]?.params?.githubDomain).toBeUndefined();
  });

  it("stores env-backed token refs for non-interactive onboarding ref mode", async () => {
    const { agentDir, runtime, run } = await onboard(undefined, {
      config: { agents: { defaults: { model: { fallbacks: ["openai/gpt-5.4"] } } } },
      opts: { secretInputMode: "ref" },
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_from_env",
        source: "env" as const,
        envVarName: "COPILOT_GITHUB_TOKEN",
      })),
    });
    const result = await run();

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.agents?.defaults?.model).toEqual({
      fallbacks: ["openai/gpt-5.4"],
      primary: "github-copilot/claude-sonnet-5",
    });

    expect(ensureAuthProfileStore(agentDir).profiles["github-copilot:github"]).toEqual({
      type: "token",
      provider: "github-copilot",
      tokenRef: {
        source: "env",
        provider: "default",
        id: "COPILOT_GITHUB_TOKEN",
      },
    });
  });

  it.each(["GITHUB_TOKEN"])("ignores %s during non-interactive onboarding", async (key) => {
    const { method, agentDir, runtime } = await authFixture();
    const pending = method.runNonInteractive({
      ...nonInteractiveContext(agentDir),
      runtime,
      resolveApiKey: vi.fn(async ({ envVar }: { envVar?: string }) =>
        envVar === key ? { key: "generic-token", source: "env", envVarName: key } : null,
      ),
    });
    await expect(pending).rejects.toThrow("Missing --github-copilot-token");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(ensureAuthProfileStore(agentDir).profiles).toEqual({});
  });

  it("preserves an existing primary model during non-interactive onboarding", async () => {
    mocks.resolveCopilotRuntimeAuth.mockResolvedValueOnce({
      apiKey: "ghu_test",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const defaults = {
      model: { primary: "github-copilot/gpt-5.4", fallbacks: ["openai/gpt-5.4"] },
      models: { "github-copilot/gpt-5.4": { label: "Existing" } },
    };
    const config = { agents: { defaults } };
    const expectedConfig = structuredClone(config);
    const { runtime, run } = await onboard("ghu_test", { config });
    const result = await run();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.agents?.defaults?.model).toEqual(expectedConfig.agents.defaults.model);
    expect(result?.agents?.defaults?.models).toEqual(expectedConfig.agents.defaults.models);
    expect(mocks.resolveCopilotStarterModel).not.toHaveBeenCalled();
    expect(mocks.resolveCopilotRuntimeAuth).toHaveBeenCalledWith({
      githubToken: "ghu_test",
      env: process.env,
      githubDomain: "github.com",
      config: expectedConfig,
    });
  });

  it("does not overwrite stored auth when a fresh token fails explicit-model validation", async () => {
    mocks.resolveCopilotRuntimeAuth.mockRejectedValueOnce(new Error("invalid credential"));
    const { agentDir, run } = await onboard("fresh-invalid-token", {
      config: { agents: { defaults: { model: { primary: "github-copilot/gpt-5.4" } } } },
    });
    writeExistingCopilotTokenProfile(agentDir);
    await expect(run()).rejects.toThrow("invalid credential");

    expect(ensureAuthProfileStore(agentDir).profiles["github-copilot:github"]).toMatchObject({
      token: "existing-token",
    });
  });

  it("reuses an existing token profile during non-interactive onboarding", async () => {
    const { agentDir, runtime, run } = await onboard(undefined);
    writeExistingCopilotTokenProfile(agentDir);
    const result = await run();

    expect(runtime.error).not.toHaveBeenCalled();
    expect(result?.auth?.profiles?.["github-copilot:github"]).toEqual({
      provider: "github-copilot",
      mode: "token",
    });
  });

  it.each([
    {
      name: "a flag without a matching environment credential",
      resolveApiKey: async () => null,
      error:
        "--github-copilot-token cannot be used with --secret-input-mode ref unless COPILOT_GITHUB_TOKEN is set in env. Set COPILOT_GITHUB_TOKEN and omit --github-copilot-token, or use --secret-input-mode plaintext.",
    },
    {
      name: "an environment credential without its reference name",
      resolveApiKey: async () => ({
        key: ["synthetic", "credential"].join("-"),
        source: "env" as const,
      }),
      error:
        '--secret-input-mode ref requires an explicit environment variable for provider "github-copilot".',
    },
  ])(
    "propagates ref-mode validation for $name before persisting auth",
    async ({ resolveApiKey, error }) => {
      const { agentDir, runtime, run } = await onboard(undefined, {
        opts: {
          githubCopilotToken: ["synthetic", "credential"].join("-"),
          secretInputMode: "ref",
        },
        resolveApiKey: vi.fn(resolveApiKey),
      });
      await expect(run()).rejects.toThrow(error);
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(ensureAuthProfileStore(agentDir).profiles).toEqual({});
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
