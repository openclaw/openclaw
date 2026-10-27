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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitHubCopilotDeviceFlow } from "./login.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<typeof fetchWithSsrFGuard>(),
  resolveCopilotRuntimeAuth: vi.fn(),
  resolveCopilotStarterModel: vi.fn(async () => "github-copilot/claude-sonnet-5"),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));
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

const {
  resolveCopilotRuntimeAuth: runtimeAuth,
  resolveCopilotStarterModel: starterModel,
  fetchWithSsrFGuard: guard,
} = mocks;
const ID = "github-copilot",
  PROFILE = "github-copilot:github",
  STARTER = "github-copilot/claude-sonnet-5";
const tempDirs: string[] = [];
let provider: ReturnType<typeof registerProviderWithPluginConfig>;
beforeEach(() => {
  provider = registerProviderWithPluginConfig({});
  guard.mockImplementation(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  }));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearRuntimeAuthProfileStoreSnapshots();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

const tokenProfile = (token: string) => ({ type: "token" as const, provider: ID, token });
const oauthProfile = (enterpriseUrl?: string) => ({
  type: "oauth" as const,
  provider: ID,
  access: "short-lived-copilot-token",
  refresh: "durable-github-token",
  expires: Date.now() + 60_000,
  ...(enterpriseUrl ? { enterpriseUrl } : {}),
});
const copilotConfig = <T>(settings: T) => ({ models: { providers: { [ID]: settings } } });
const domainOf = (config?: Partial<OpenClawConfig> | ProviderAuthResult["configPatch"] | null) =>
  config?.models?.providers?.[ID]?.params?.githubDomain;
const storedToken = (token: string) => ({
  profileId: PROFILE,
  credential: tokenProfile(token),
  secretStorage: { kind: "store", namePrefix: "GITHUB_COPILOT_TOKEN" },
});
function noCalls(...functions: unknown[]) {
  for (const fn of functions) {
    expect(fn).not.toHaveBeenCalled();
  }
}
async function createAgentDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-copilot-test-"));
  tempDirs.push(dir);
  return dir;
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
const writeExisting = (dir: string) =>
  writeProfiles(dir, { [PROFILE]: tokenProfile("existing-token") });
const readToken = (dir: string) => ensureAuthProfileStore(dir).profiles[PROFILE];
const mockRuntimeAuth = (apiKey: string, baseUrl: string) =>
  runtimeAuth.mockResolvedValue({ apiKey, baseUrl });
const modelRegistry = () => ({
  getAll: vi.fn(() => []),
  getAvailable: vi.fn(() => []),
  find: vi.fn(() => undefined),
  hasConfiguredAuth: vi.fn(() => false),
});
function catalogModel(
  id: string,
  limits = {},
  extra = {},
  supports: Record<string, unknown> | null = { streaming: true, tool_calls: true },
) {
  return {
    id,
    name: id,
    model_picker_enabled: true,
    policy: { state: "enabled" },
    capabilities: { type: "chat", ...(supports ? { supports } : {}), limits },
    ...extra,
  };
}
function mockCatalog(data: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data })),
  );
}
function catalog(agentDir: string, config = {}, env = {}) {
  return provider.catalog.run({ agentDir, config, env });
}
async function withDeviceTimers<T>(
  run: (openUrl: (url: string) => Promise<void>) => T | Promise<T>,
): Promise<T> {
  vi.useFakeTimers();
  try {
    const { promise: ready, resolve: shown } = Promise.withResolvers<void>();
    const pending = Promise.resolve(run(async () => shown()));
    expect(await Promise.race([ready.then(() => true), pending.then(() => false)])).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}
async function interactive(existing = false, index = 0, domain = "") {
  const dir = await createAgentDir();
  if (existing) {
    writeExisting(dir);
  }
  const context = interactiveContext(dir);
  const method = requireAuthMethod(provider.auth, index);
  const prompter = {
    confirm: vi.fn(async () => false),
    text: vi.fn(async () => domain),
    note: vi.fn(async (_message: string, _title?: string) => {}),
  };
  const run = (options = {}) => method.run({ ...context, prompter, openUrl: vi.fn(), ...options });
  return {
    dir,
    prompter,
    run,
    login: (options = {}) => withDeviceTimers((openUrl) => run({ ...options, openUrl })),
  };
}
async function onboard(token?: string, overrides = {}) {
  const dir = await createAgentDir();
  const runtime = { error: vi.fn(), exit: vi.fn() };
  const method = requireAuthMethod(provider.auth, 0);
  return {
    dir,
    runtime,
    run: () =>
      method.runNonInteractive({
        authChoice: ID,
        config: {},
        baseConfig: {},
        opts: token ? { githubCopilotToken: token } : {},
        agentDir: dir,
        toApiKeyCredential: vi.fn(),
        runtime,
        resolveApiKey: token
          ? vi.fn(async () => ({ key: token, source: "flag" as const }))
          : vi.fn(async () => null),
        ...overrides,
      }),
  };
}
function deviceFetch(domain: string, accessToken: string) {
  const responses = new Map<string, unknown>([
    [
      `https://${domain}/login/device/code`,
      {
        device_code: "device-code-stub",
        user_code: "ABCD-1234",
        verification_uri: `https://${domain}/login/device`,
        expires_in: 900,
        interval: 0,
      },
    ],
    [
      `https://${domain}/login/oauth/access_token`,
      { access_token: accessToken, token_type: "bearer" },
    ],
  ]);
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!responses.has(url)) {
      throw new Error(`unexpected fetch in github-copilot device flow test: ${url}`);
    }
    return Response.json(responses.get(url));
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("github-copilot plugin", () => {
  it("registers embedding provider", () => {
    const register = vi.fn<OpenClawPluginApi["registerEmbeddingProvider"]>();
    plugin.register(createTestPluginApi({ registerEmbeddingProvider: register }));
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls[0]?.[0].id).toBe(ID);
  });
  it("normalizes legacy OAuth profiles without losing tenant metadata", async () => {
    const credential = { ...oauthProfile("acme.ghe.com"), expires: 1 },
      before = { ...credential };
    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
      ...credential,
      access: "durable-github-token",
      expires: MAX_DATE_TIMESTAMP_MS,
    });
    expect(credential).toEqual(before);
  });
  it("rejects unsafe legacy OAuth tenants before formatting or refresh", async () => {
    const credential = { ...oauthProfile("attacker.example"), expires: 1 };
    expect(() => provider.formatApiKey?.(credential)).toThrow(/attacker\.example/);
    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow(/attacker\.example/);
  });
  it("owns unsupported legacy OAuth doctor guidance", async () => {
    const store = { version: 1, profiles: { [PROFILE]: oauthProfile("attacker.example") } };
    const hint = () => provider.buildAuthDoctorHint?.({ store, provider: ID, profileId: PROFILE });
    expect(await hint()).toContain("unsupported enterprise domain");
    store.profiles[PROFILE].enterpriseUrl = "acme.ghe.com";
    expect(await hint()).toBeUndefined();
  });
  it("rejects unresolved integration SecretRefs before catalog or inference", async () => {
    const config = copilotConfig({
      request: {
        headers: {
          "Copilot-Integration-Id": { source: "env", provider: "default", id: "IDENTITY" },
        },
      },
    });
    mockRuntimeAuth("github-source-token", "https://copilot-api.acme.ghe.com");
    const fetchMock = vi.fn<typeof fetch>(),
      streamFn = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      catalog(await createAgentDir(), config, { COPILOT_GITHUB_TOKEN: "github-source-token" }),
    ).rejects.toMatchObject({ name: "UnresolvedSecretInputError" });
    const model = { id: "claude-sonnet-5", provider: ID, api: "openai-responses" };
    for (const wrap of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
      const wrapped = wrap?.({ config, streamFn } as never);
      expect(() => wrapped?.(model as never, { messages: [] }, {})).toThrow(
        expect.objectContaining({ name: "UnresolvedSecretInputError" }),
      );
    }
    noCalls(streamFn, fetchMock);
  });
  it("keeps secret headers sealed and sends public identity through stream wrappers", async () => {
    const auth = {
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    };
    runtimeAuth.mockResolvedValue(auth);
    const prepare = (headers?: Record<string, string>) =>
      provider.prepareRuntimeAuth({
        config: {},
        env: {},
        provider: ID,
        modelId: "gpt-5.4-mini",
        model: { id: "gpt-5.4-mini", provider: ID, headers },
        apiKey: auth.apiKey,
        authMode: "token",
      } as never);
    await expect(prepare()).resolves.toEqual(auth);
    await expect(prepare({ "X-Opaque": "inline-header-credential" })).resolves.toEqual({
      ...auth,
      request: { headers: { "X-Opaque": "inline-header-credential" } },
    });
    const streamFn = vi.fn();
    const wrapped = provider.wrapSimpleCompletionStreamFn?.({ config: {}, streamFn } as never);
    void wrapped?.(
      {
        id: "gpt-5.4-mini",
        provider: ID,
        api: "openai-completions",
        headers: { "X-Custom": "kept" },
      } as never,
      { messages: [] },
      {},
    );
    expect(streamFn.mock.calls[0]?.[2]?.headers).toMatchObject({
      "Openai-Organization": ID,
      "Copilot-Integration-Id": "copilot-developer-cli",
      "X-Custom": "kept",
    });
  });
  it("isolates live catalogs by integration identity and excludes private headers", async () => {
    const agentDir = await createAgentDir(),
      registry = modelRegistry(),
      observed: Headers[] = [];
    writeExisting(agentDir);
    mockRuntimeAuth("identity-catalog-token", "https://copilot-api.acme.ghe.com");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        const headers = new Headers(init?.headers);
        observed.push(headers);
        return Response.json({
          data: [
            catalogModel("gpt-5-mini", {
              max_context_window_tokens:
                headers.get("copilot-integration-id") === "vscode-chat" ? 100_000 : 200_000,
            }),
          ],
        });
      }),
    );
    for (const [identity, contextWindow] of [
      ["vscode-chat", 100_000],
      ["copilot-developer-cli", 200_000],
    ] as const) {
      const config = copilotConfig({
        baseUrl: "https://copilot-api.acme.ghe.com",
        models: [],
        headers: { "copilot-integration-id": identity, "X-Private-Header": "not-for-catalog" },
      });
      const result = await catalog(agentDir, config, {
        COPILOT_GITHUB_TOKEN: "identity-catalog-token",
      });
      expect(result && "provider" in result ? result.provider.models : []).toMatchObject([
        { id: "gpt-5-mini", contextWindow },
      ]);
      const context = {
        config,
        agentDir,
        modelRegistry: registry,
        provider: ID,
        modelId: "gpt-5-mini",
        authProfileId: PROFILE,
      };
      await provider.prepareDynamicModel(context);
      expect(provider.resolveDynamicModel(context)).toMatchObject({
        id: "gpt-5-mini",
        contextWindow,
      });
    }
    expect(observed).toHaveLength(2);
    expect(observed.every((headers) => !headers.has("x-private-header"))).toBe(true);
  });
  it.each([
    [undefined, "github.com", undefined],
    ["acme.ghe.com", "override.ghe.com", "override.ghe.com"],
  ])(
    "discovers OAuth tenant %s with effective domain %s",
    async (tenant, expectedDomain, override) => {
      const dir = await createAgentDir();
      writeProfiles(dir, {
        "github-copilot:first": tokenProfile("first-token"),
        "github-copilot:preferred": oauthProfile(tenant),
      });
      mockRuntimeAuth("preferred-copilot-token", "https://api.githubcopilot.preferred");
      mockCatalog([
        catalogModel("gpt-5.4", { max_context_window_tokens: 200_000, max_output_tokens: 64_000 }),
      ]);
      const env = override ? { COPILOT_GITHUB_DOMAIN: override } : {};
      const result = await catalog(
        dir,
        {
          auth: { order: { [ID]: ["github-copilot:preferred"] } },
          ...copilotConfig({
            baseUrl: "https://api.githubcopilot.com",
            models: [],
            params: { githubDomain: "other.ghe.com" },
          }),
        },
        env,
      );
      expect(runtimeAuth).toHaveBeenCalledWith({
        githubToken: "durable-github-token",
        env,
        githubDomain: expectedDomain,
      });
      expect(
        result && "provider" in result ? result.provider.models.map(({ id }) => id) : [],
      ).toEqual(["gpt-5.4"]);
    },
  );
  it("ignores generic GITHUB_TOKEN during catalog discovery", async () => {
    expect(await catalog(await createAgentDir(), {}, { GITHUB_TOKEN: "generic-token" })).toBeNull();
    noCalls(runtimeAuth);
  });
  it("rejects unavailable direct SecretRefs without ambient fallback", async () => {
    const config = copilotConfig({
      apiKey: { source: "env", provider: "default", id: "OPENCLAW_MISSING_COPILOT_CATALOG_TOKEN" },
    });
    await expect(
      catalog(await createAgentDir(), config, { COPILOT_GITHUB_TOKEN: "ambient-token" }),
    ).rejects.toThrow("models.providers.github-copilot.apiKey");
    noCalls(runtimeAuth, guard);
  });
  it("exposes bundled Claude Opus 5 xhigh and max thinking", () => {
    const model = expectDefined(
      manifest.modelCatalog.providers[ID].models.find(({ id }) => id === "claude-opus-5"),
      "bundled Opus 5",
    );
    expect(
      provider
        .resolveThinkingProfile({ provider: ID, modelId: model.id, compat: model.compat })
        ?.levels.map(({ id }) => id),
    ).toEqual(expect.arrayContaining(["xhigh", "max"]));
  });
  it.each([
    ["gpt-5.4-mini", ["none", "low", "medium", "high", "xhigh"], true],
    ["gpt-5-mini", ["low", "medium", "high"], false],
  ] as const)("gates %s xhigh on live catalog effort", (modelId, efforts, xhigh) => {
    const profile = provider.resolveThinkingProfile({
      provider: ID,
      modelId,
      compat: { supportedReasoningEfforts: [...efforts] },
    });
    expect(profile).toBeDefined();
    expect(profile?.levels.some(({ id }) => id === "xhigh") ?? false).toBe(xhigh);
  });
  it("filters hidden and disabled models without excluding chat-only models", async () => {
    mockRuntimeAuth("catalog-policy-token", "https://api.githubcopilot.policy-test");
    mockCatalog([
      catalogModel(
        "eligible",
        { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
        { model_picker_category: "versatile" },
      ),
      catalogModel("disabled", {}, { policy: { state: "disabled" } }),
      catalogModel("hidden", {}, { model_picker_enabled: false }),
      catalogModel(
        "chat-only",
        {},
        { capabilities: { type: "chat", supports: { streaming: false, tool_calls: false } } },
      ),
    ]);
    const result = await catalog(
      "/tmp/agent",
      {},
      { COPILOT_GITHUB_TOKEN: "catalog-source-token" },
    );
    expect(
      result && "provider" in result ? result.provider.models.map(({ id }) => id) : [],
    ).toEqual(["eligible", "chat-only"]);
  });
  it.each(["user", "models"])("records unavailable catalog attempts at %s", async (stage) => {
    const dir = await createAgentDir();
    writeExisting(dir);
    runtimeAuth.mockReset();
    if (stage === "user") {
      runtimeAuth.mockRejectedValue(
        new CopilotRuntimeAuthError({ reason: "http_error", status: 503 }),
      );
    } else {
      mockRuntimeAuth("catalog-attempt-token", "https://api.githubcopilot.attempt-503");
    }
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ data: [] }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await catalog(dir);
    expect(result?.outcomes).toEqual([{ provider: ID, profileId: PROFILE, status: "unavailable" }]);
    expect(result && "providers" in result ? result.providers : undefined).toEqual({});
    expect(runtimeAuth).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(stage === "user" ? 0 : 1);
  });
  it.each([true, false])(
    "returns supplied credentials without login (credentialOnly=%s)",
    async (credentialOnly) => {
      const { dir, prompter, run } = await interactive(true);
      const before = structuredClone(ensureAuthProfileStore(dir)),
        openUrl = vi.fn();
      const result = await run({
        credentialOnly,
        opts: { tokenProvider: ID, token: "supplied-setup-token" },
        isRemote: true,
        openUrl,
        existingProfiles: undefined,
      });
      expect(result).toMatchObject({ profiles: [storedToken("supplied-setup-token")] });
      if (credentialOnly) {
        expect(result?.defaultModel).toBeUndefined();
      } else {
        expect(result?.defaultModel).toBeTruthy();
      }
      expect(ensureAuthProfileStore(dir)).toEqual(before);
      noCalls(prompter.confirm, prompter.text, openUrl, runtimeAuth, starterModel);
    },
  );
  it("keeps valid interactive auth when live discovery fails", async () => {
    starterModel.mockRejectedValueOnce(new Error("catalog unavailable"));
    const { run } = await interactive(true);
    const result = await run({ secretInputMode: "plaintext" });
    expect(result).toMatchObject({
      profiles: [{ profileId: PROFILE, credential: tokenProfile("existing-token") }],
      notes: [expect.stringContaining("authentication succeeded")],
    });
    expect(result?.defaultModel).toBeUndefined();
  });
  it.each([false, true])(
    "isolates prepared metadata across profile fallback=%s",
    async (fallback) => {
      const dir = await createAgentDir();
      const tokens = fallback ? ["test-auth-token", "test-token-placeholder"] : ["chosen", "first"];
      const hosts = fallback ? ["profile", "direct"] : ["live", "first"];
      const limits = fallback
        ? [
            [200_000, 150_000],
            [1_050_000, 922_000],
          ]
        : [
            [1_050_000, 922_000],
            [400_000, 272_000],
          ];
      writeProfiles(dir, {
        "github-copilot:first": tokenProfile(fallback ? tokens[0]! : tokens[1]!),
        ...(!fallback ? { "github-copilot:selected": tokenProfile(tokens[0]!) } : {}),
      });
      const fetchMock = vi.fn();
      for (const [i, token] of tokens.entries()) {
        runtimeAuth.mockResolvedValueOnce({
          apiKey: token,
          baseUrl: `https://api.githubcopilot.${hosts[i]}`,
        });
        const model = catalogModel(
          "gpt-5.6-sol",
          {
            max_context_window_tokens: limits[i]![0],
            max_prompt_tokens: limits[i]![1],
            max_output_tokens: 128_000,
          },
          {},
          fallback
            ? null
            : { vision: true, reasoning_effort: ["none", "low", "medium", "high", "xhigh"] },
        );
        fetchMock.mockResolvedValueOnce(Response.json({ data: [model] }));
      }
      vi.stubGlobal("fetch", fetchMock);
      const first = {
        config: fallback
          ? copilotConfig({
              apiKey: tokens[1],
              baseUrl: "https://api.githubcopilot.test",
              models: [],
            })
          : {},
        agentDir: dir,
        provider: ID,
        modelId: "gpt-5.6-sol",
        modelRegistry: modelRegistry(),
        authProfileId: fallback ? "github-copilot:first" : "github-copilot:selected",
      } as Parameters<typeof provider.prepareDynamicModel>[0];
      const second = {
        ...first,
        authProfileId: fallback ? undefined : "github-copilot:first",
        ...(fallback ? { authProfileMode: "api_key" as const } : {}),
      };
      // Both scopes are prepared before either is read: last-write-wins leakage must fail.
      await provider.prepareDynamicModel(first);
      await provider.prepareDynamicModel(second);
      if (!fallback) {
        expect(provider.preferRuntimeResolvedModel(first)).toBe(true);
      }
      for (const [i, context] of [first, second].entries()) {
        expect(runtimeAuth).toHaveBeenNthCalledWith(i + 1, {
          githubToken: tokens[i],
          env: process.env,
          githubDomain: "github.com",
        });
        expect(provider.resolveDynamicModel(context)).toMatchObject({
          ...(!fallback ? { id: "gpt-5.6-sol", provider: ID, maxTokens: 128_000 } : {}),
          baseUrl: `https://api.githubcopilot.${hosts[i]}`,
          contextWindow: limits[i]![0],
          contextTokens: limits[i]![1],
        });
      }
    },
  );
  it("threads authority into the guarded device request", async () => {
    const { run } = await interactive();
    let current = true;
    const dispatch = vi.fn();
    guard.mockImplementation(async (params) => {
      await Promise.resolve();
      current = false;
      params.beforeRequest?.();
      dispatch();
      throw new Error("Request dispatched after authority was revoked");
    });
    await expect(
      run({
        credentialOnly: true,
        isRemote: true,
        existingProfiles: undefined,
        assertCurrent: () => {
          if (!current) {
            throw new Error("Login revoked");
          }
        },
      }),
    ).rejects.toThrow("Login revoked");
    noCalls(dispatch);
  });
  it.each([
    { index: 1, domain: "acme.ghe.com", existing: false, credentialOnly: true },
    { index: 0, domain: "github.com", existing: true, credentialOnly: false },
  ])(
    "starts fresh $domain login without unauthorized stored credentials",
    async ({ index, domain, existing, credentialOnly }) => {
      const { prompter, login } = await interactive(existing, index, domain);
      prompter.confirm.mockImplementation(async () => {
        throw new Error("Login must not offer unauthorized stored credentials");
      });
      const fetchMock = deviceFetch(domain, "connected-token");
      const result = await login({ credentialOnly, isRemote: true, existingProfiles: undefined });
      expect(result?.profiles).toEqual([storedToken("connected-token")]);
      expect(result?.defaultModel).toBe(credentialOnly ? undefined : STARTER);
      expect(result?.configPatch).toEqual(
        index === 1 ? copilotConfig({ params: { githubDomain: domain } }) : undefined,
      );
      expect(starterModel).toHaveBeenCalledTimes(credentialOnly ? 0 : 1);
      expect(prompter.text).toHaveBeenCalledTimes(index);
      noCalls(prompter.confirm, runtimeAuth);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it.each([false, true])(
    "forces a fresh login when changing tenant (public=%s)",
    async (publicLogin) => {
      const domain = publicLogin ? "github.com" : "acme.ghe.com",
        token = publicLogin ? "public-fresh-token" : "tenant-fresh-token";
      const { login, prompter } = await interactive(
        true,
        publicLogin ? 0 : 1,
        publicLogin ? "" : "typed-tenant.ghe.com",
      );
      deviceFetch(domain, token);
      const result = await login(
        publicLogin
          ? { config: copilotConfig({ params: { githubDomain: "acme.ghe.com" } }) }
          : { env: { COPILOT_GITHUB_DOMAIN: domain }, secretInputMode: "plaintext" },
      );
      noCalls(prompter.confirm);
      expect(result?.profiles[0]).toEqual(
        publicLogin ? storedToken(token) : { profileId: PROFILE, credential: tokenProfile(token) },
      );
      expect(domainOf(result?.configPatch)).toBe(publicLogin ? undefined : domain);
      if (publicLogin) {
        const [message] = expectDefined(
          prompter.note.mock.calls.find(([, title]) => title === "Authorize GitHub Copilot"),
          "device-code note",
        );
        expect(markdownToIR(message, { linkify: false }).links.map(({ href }) => href)).toEqual([
          "https://github.com/login/device",
        ]);
        expect(message).toContain("\nCode: ABCD-1234\n");
        expect(
          Object.hasOwn(result?.configPatch?.models?.providers?.[ID]?.params ?? {}, "githubDomain"),
        ).toBe(true);
      } else {
        noCalls(prompter.text);
      }
    },
  );
  it("reuses the host-authorized reference for the same tenant", async () => {
    const { run, prompter } = await interactive(true, 1, "acme.ghe.com");
    const authorized: ProviderAuthResult["profiles"][number] = {
      profileId: "github-copilot:authorized",
      credential: {
        type: "token",
        provider: ID,
        tokenRef: { source: "env", provider: "default", id: "AUTHORIZED_COPILOT_TOKEN" },
      },
    };
    const result = await run({
      env: { AUTHORIZED_COPILOT_TOKEN: "authorized-token" },
      existingProfiles: [authorized],
      config: copilotConfig({ params: { githubDomain: "acme.ghe.com" } }),
      secretInputMode: "plaintext",
    });
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "GitHub Copilot auth already exists. Re-run login?",
      initialValue: false,
    });
    expect(result?.profiles).toEqual([authorized]);
    expect(starterModel).toHaveBeenCalledWith(
      expect.objectContaining({ githubToken: "authorized-token", githubDomain: "acme.ghe.com" }),
    );
    expect(domainOf(result?.configPatch)).toBe("acme.ghe.com");
  });
  it("rejects unsafe device-code lifetimes before polling", async () => {
    const release = vi.fn(async () => {}),
      showCode = vi.fn();
    guard.mockImplementation(async () => ({
      response: new Response(
        '{"device_code":"device-code-stub","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":1e309,"interval":0}',
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
      finalUrl: "https://github.com/login/device/code",
      release,
    }));
    await expect(runGitHubCopilotDeviceFlow({ showCode })).rejects.toThrow(
      "GitHub device code response missing fields",
    );
    noCalls(showCode);
    expect(release).toHaveBeenCalledOnce();
  });
  it("does not persist a token when starter discovery fails", async () => {
    starterModel.mockRejectedValueOnce(new Error("no eligible models"));
    const { dir, run } = await onboard("ghu_invalid_for_catalog");
    await expect(run()).rejects.toThrow("no eligible models");
    expect(readToken(dir)).toBeUndefined();
  });
  it.each(["acme.ghe.com", "github.com"])(
    "persists the effective onboarding domain %s",
    async (domain) => {
      vi.stubEnv("COPILOT_GITHUB_DOMAIN", domain);
      const { dir, runtime, run } = await onboard(
        "ghu_test123",
        domain === "github.com"
          ? { config: copilotConfig({ params: { githubDomain: "acme.ghe.com" } }) }
          : {},
      );
      const result = await run();
      noCalls(runtime.error);
      expect(domainOf(result)).toBe(domain === "github.com" ? undefined : domain);
      if (domain !== "github.com") {
        expect(result?.auth?.profiles?.[PROFILE]).toEqual({ provider: ID, mode: "token" });
        expect(readToken(dir)).toEqual(tokenProfile("ghu_test123"));
      }
    },
  );
  it("stores env-backed references and preserves model fallbacks", async () => {
    const { dir, runtime, run } = await onboard(undefined, {
      config: { agents: { defaults: { model: { fallbacks: ["openai/gpt-5.4"] } } } },
      opts: { secretInputMode: "ref" },
      resolveApiKey: vi.fn(async () => ({
        key: "ghu_from_env",
        source: "env" as const,
        envVarName: "COPILOT_GITHUB_TOKEN",
      })),
    });
    const result = await run();
    noCalls(runtime.error);
    expect(result?.agents?.defaults?.model).toEqual({
      fallbacks: ["openai/gpt-5.4"],
      primary: STARTER,
    });
    expect(readToken(dir)).toEqual({
      type: "token",
      provider: ID,
      tokenRef: { source: "env", provider: "default", id: "COPILOT_GITHUB_TOKEN" },
    });
  });
  it("ignores generic GITHUB_TOKEN during non-interactive onboarding", async () => {
    const { dir, runtime, run } = await onboard(undefined, {
      resolveApiKey: vi.fn(async ({ envVar }: { envVar?: string }) =>
        envVar === "GITHUB_TOKEN"
          ? { key: "generic-token", source: "env", envVarName: envVar }
          : null,
      ),
    });
    await expect(run()).rejects.toThrow("Missing --github-copilot-token");
    noCalls(runtime.error, runtime.exit);
    expect(ensureAuthProfileStore(dir).profiles).toEqual({});
  });
  it("preserves an existing primary model", async () => {
    mockRuntimeAuth("ghu_test", "https://api.individual.githubcopilot.com");
    const config = {
      agents: {
        defaults: {
          model: { primary: "github-copilot/gpt-5.4", fallbacks: ["openai/gpt-5.4"] },
          models: { "github-copilot/gpt-5.4": { label: "Existing" } },
        },
      },
    };
    const before = structuredClone(config),
      { runtime, run } = await onboard("ghu_test", { config });
    const result = await run();
    noCalls(runtime.error, starterModel);
    expect(result?.agents?.defaults?.model).toEqual(before.agents.defaults.model);
    expect(result?.agents?.defaults?.models).toEqual(before.agents.defaults.models);
    expect(runtimeAuth).toHaveBeenCalledWith({
      githubToken: "ghu_test",
      env: process.env,
      githubDomain: "github.com",
      config: before,
    });
  });
  it("does not overwrite stored auth after explicit-model validation fails", async () => {
    runtimeAuth.mockRejectedValueOnce(new Error("invalid credential"));
    const { dir, run } = await onboard("fresh-invalid-token", {
      config: { agents: { defaults: { model: { primary: "github-copilot/gpt-5.4" } } } },
    });
    writeExisting(dir);
    await expect(run()).rejects.toThrow("invalid credential");
    expect(readToken(dir)).toMatchObject({ token: "existing-token" });
  });
  it("reuses an existing non-interactive token", async () => {
    const { dir, runtime, run } = await onboard();
    writeExisting(dir);
    const result = await run();
    noCalls(runtime.error);
    expect(result?.auth?.profiles?.[PROFILE]).toEqual({ provider: ID, mode: "token" });
  });
  it.each([
    {
      name: "flag without matching environment credential",
      resolveApiKey: async () => null,
      error:
        "--github-copilot-token cannot be used with --secret-input-mode ref unless COPILOT_GITHUB_TOKEN is set in env. Set COPILOT_GITHUB_TOKEN and omit --github-copilot-token, or use --secret-input-mode plaintext.",
    },
    {
      name: "environment credential without reference name",
      resolveApiKey: async () => ({ key: "synthetic-credential", source: "env" as const }),
      error:
        '--secret-input-mode ref requires an explicit environment variable for provider "github-copilot".',
    },
  ])("rejects $name before persistence", async ({ resolveApiKey, error }) => {
    const { dir, runtime, run } = await onboard(undefined, {
      opts: { githubCopilotToken: "synthetic-credential", secretInputMode: "ref" },
      resolveApiKey: vi.fn(resolveApiKey),
    });
    await expect(run()).rejects.toThrow(error);
    noCalls(runtime.error, runtime.exit);
    expect(ensureAuthProfileStore(dir).profiles).toEqual({});
  });
});
