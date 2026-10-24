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
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { runGitHubCopilotDeviceFlow } from "./login.js";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

const { guard, runtimeAuth, starterModel } = vi.hoisted(() => ({
  guard: vi.fn<typeof fetchWithSsrFGuard>(),
  runtimeAuth: vi.fn(),
  starterModel: vi.fn(async () => "github-copilot/claude-sonnet-5"),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guard,
}));
vi.mock("./register.runtime.js", () => ({
  resolveCopilotRuntimeAuth: runtimeAuth,
  resolveCopilotStarterModel: starterModel,
}));
import {
  interactiveContext,
  registerProviderWithPluginConfig,
  requireAuthMethod,
} from "./provider.test-support.js";

const ID = "github-copilot",
  PROFILE = "github-copilot:github",
  STARTER = "github-copilot/claude-sonnet-5";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    clearRuntimeAuthProfileStoreSnapshots();
    cleanup();
  }),
);
const createAgentDir = () => tempDirs.make("openclaw-github-copilot-test-");
let provider: ReturnType<typeof registerProviderWithPluginConfig>;
beforeEach(() => {
  provider = registerProviderWithPluginConfig({});
  guard.mockImplementation(async (params) => ({
    response: await fetch(params.url, params.init),
    finalUrl: params.url,
    release: vi.fn(async () => {}),
  }));
});
afterAll(() => {
  vi.doUnmock("./register.runtime.js");
  vi.resetModules();
});

const tokenProfile = (token: string) => ({ type: "token" as const, provider: ID, token });
const oauthProfile = (enterpriseUrl: string) => ({
  type: "oauth" as const,
  provider: ID,
  access: "short-lived-copilot-token",
  refresh: "durable-github-token",
  expires: 1,
  enterpriseUrl,
});
const copilotConfig = <T>(settings: T) => ({ models: { providers: { [ID]: settings } } });
const domainOf = (config?: Partial<OpenClawConfig> | ProviderAuthResult["configPatch"] | null) =>
  config?.models?.providers?.[ID]?.params?.githubDomain;
const storedToken = (token: string) => ({
  profileId: PROFILE,
  credential: tokenProfile(token),
  secretStorage: { kind: "store", namePrefix: "GITHUB_COPILOT_TOKEN" },
});
const noCalls = (...fns: unknown[]) => fns.forEach((fn) => expect(fn).not.toHaveBeenCalled());
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
const catalogModel = (id: string, limits = {}, extra = {}) => ({
  id,
  model_picker_enabled: true,
  capabilities: { type: "chat", limits },
  ...extra,
});
const catalog = (agentDir: string, config = {}, env = {}) =>
  provider.catalog.run({ agentDir, config, env });
const catalogModels = (result: Awaited<ReturnType<typeof catalog>>) =>
  result && "provider" in result ? result.provider.models : [];
const domainConfig = (githubDomain?: string) => copilotConfig({ params: { githubDomain } });
type OpenUrl = (url: string) => Promise<void>;
async function withDeviceTimers<T>(run: (openUrl: OpenUrl) => T | Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const { promise, resolve } = Promise.withResolvers<void>();
  const pending = Promise.resolve(run(async () => resolve()));
  expect(await Promise.race([promise.then(() => true), pending.then(() => false)])).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  return await pending;
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
  return {
    dir,
    run: () =>
      requireAuthMethod(provider.auth, 0).runNonInteractive({
        config: {},
        baseConfig: {},
        opts: token ? { githubCopilotToken: token } : {},
        agentDir: dir,
        resolveApiKey: vi.fn(async () => (token ? { key: token, source: "flag" as const } : null)),
        ...overrides,
      }),
  };
}
function deviceFetch(domain: string, accessToken: string) {
  const responses: Record<string, unknown> = {
    [`https://${domain}/login/device/code`]: {
      device_code: "device-code-stub",
      user_code: "ABCD-1234",
      verification_uri: `https://${domain}/login/device`,
      expires_in: 900,
      interval: 0,
    },
    [`https://${domain}/login/oauth/access_token`]: { access_token: accessToken },
  };
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!Object.hasOwn(responses, url)) {
      throw new Error(`unexpected fetch in github-copilot device flow test: ${url}`);
    }
    return Response.json(responses[url]);
  });
  vi.stubGlobal("fetch", fn);
}

it("registers embedding provider", () => {
  const register = vi.fn<OpenClawPluginApi["registerEmbeddingProvider"]>();
  plugin.register(createTestPluginApi({ registerEmbeddingProvider: register }));
  expect(register.mock.calls[0]?.[0].id).toBe(ID);
});
it.each(["acme.ghe.com", "attacker.example"])("validates OAuth tenant %s", async (domain) => {
  const credential = oauthProfile(domain),
    before = { ...credential };
  const hint = await provider.buildAuthDoctorHint?.({
    store: { version: 1, profiles: { [PROFILE]: credential } },
    provider: ID,
    profileId: PROFILE,
  });
  if (domain === "attacker.example") {
    expect(hint).toContain("unsupported enterprise domain");
    expect(() => provider.formatApiKey?.(credential)).toThrow(/attacker\.example/);
    await expect(provider.refreshOAuth?.(credential)).rejects.toThrow(/attacker\.example/);
  } else {
    expect(hint).toBeUndefined();
    await expect(provider.refreshOAuth?.(credential)).resolves.toEqual({
      ...before,
      access: "durable-github-token",
      expires: MAX_DATE_TIMESTAMP_MS,
    });
    expect(credential).toEqual(before);
  }
});
it("rejects unresolved integration identity", async () => {
  const ref = { source: "env", provider: "default", id: "IDENTITY" };
  const config = copilotConfig({ request: { headers: { "Copilot-Integration-Id": ref } } });
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
it("seals secret headers and streams public identity", async () => {
  const auth = {
    apiKey: "github-source-token",
    baseUrl: "https://api.individual.githubcopilot.com",
  };
  runtimeAuth.mockResolvedValue(auth);
  const prepare = (headers?: Record<string, string>) =>
    provider.prepareRuntimeAuth({
      config: {},
      env: {},
      model: { headers },
      apiKey: auth.apiKey,
    } as never);
  await expect(prepare()).resolves.toEqual(auth);
  await expect(prepare({ "X-Opaque": "inline-header-credential" })).resolves.toEqual({
    ...auth,
    request: { headers: { "X-Opaque": "inline-header-credential" } },
  });
  const streamFn = vi.fn();
  const wrapped = provider.wrapSimpleCompletionStreamFn?.({ config: {}, streamFn } as never);
  const model = { headers: { "X-Custom": "kept" } };
  void wrapped?.(model as never, { messages: [] }, {});
  expect(streamFn.mock.calls[0]?.[2]?.headers).toMatchObject({
    "Openai-Organization": ID,
    "Copilot-Integration-Id": "copilot-developer-cli",
    "X-Custom": "kept",
  });
});
it.each(["integration", "profile", "direct"] as const)("isolates %s catalogs", async (scope) => {
  const agentDir = await createAgentDir(),
    registry = modelRegistry();
  writeProfiles(agentDir, { [PROFILE]: tokenProfile("first"), second: tokenProfile("second") });
  const contexts = ["first", "second"].map((token, index) => ({
    agentDir,
    modelRegistry: registry,
    provider: ID,
    modelId: "gpt-5-mini",
    authProfileId:
      scope === "integration" || index === 0 ? PROFILE : scope === "profile" ? "second" : undefined,
    authProfileMode: scope === "direct" && index === 1 ? ("api_key" as const) : undefined,
    config: copilotConfig({
      apiKey: "second",
      baseUrl: "https://api.githubcopilot.test",
      models: [],
      headers: {
        "Copilot-Integration-Id": scope === "integration" ? token : scope,
        "X-Private-Header": "private",
      },
    }),
  }));
  runtimeAuth.mockImplementation(async ({ githubToken }: { githubToken: string }) => ({
    apiKey: githubToken,
    baseUrl: `https://api.githubcopilot.${githubToken}`,
  }));
  const expected = [200_000, 400_000].map((contextWindow, index) => ({
    contextWindow,
    baseUrl: `https://api.githubcopilot.${scope === "integration" || !index ? "first" : "second"}`,
  }));
  const fetchMock = vi.fn<typeof fetch>();
  const filtered =
    scope === "integration"
      ? [
          catalogModel("disabled", {}, { policy: { state: "disabled" } }),
          catalogModel("hidden", {}, { model_picker_enabled: false }),
          catalogModel(
            "chat-only",
            {},
            { capabilities: { type: "chat", supports: { streaming: false, tool_calls: false } } },
          ),
        ]
      : [];
  for (const model of expected) {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        data: [
          catalogModel("gpt-5-mini", { max_context_window_tokens: model.contextWindow }),
          ...filtered,
        ],
      }),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  for (const [index, context] of contexts.entries()) {
    if (scope === "integration") {
      const result = await catalog(agentDir, context.config, { COPILOT_GITHUB_TOKEN: "first" });
      expect(catalogModels(result).map(({ id }) => id)).toEqual(["gpt-5-mini", "chat-only"]);
    }
    await provider.prepareDynamicModel(context);
    if (scope === "integration") {
      expect(provider.resolveDynamicModel(context)).toMatchObject(expected[index]!);
    }
  }
  // Read after both preparations to catch last-write-wins across credential scopes.
  if (scope !== "integration") {
    contexts.forEach((context, index) =>
      expect(provider.resolveDynamicModel(context)).toMatchObject(expected[index]!),
    );
  } else {
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("copilot-integration-id"),
      ),
    ).toEqual(["first", "second"]);
  }
  expect(
    fetchMock.mock.calls.every(([, init]) => !new Headers(init?.headers).has("x-private-header")),
  ).toBe(true);
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
});
it.each([true, false])("uses supplied tokens (credentialOnly=%s)", async (credentialOnly) => {
  const { dir, prompter, run } = await interactive(true);
  const before = structuredClone(ensureAuthProfileStore(dir)),
    openUrl = vi.fn();
  const result = await run({
    credentialOnly,
    opts: { tokenProvider: ID, token: "supplied-setup-token" },
    openUrl,
  });
  expect(result).toMatchObject({ profiles: [storedToken("supplied-setup-token")] });
  expect(result?.defaultModel).toBe(credentialOnly ? undefined : STARTER);
  expect(ensureAuthProfileStore(dir)).toEqual(before);
  noCalls(prompter.confirm, prompter.text, openUrl, runtimeAuth, starterModel);
});
it("threads authority into the guarded device request", async () => {
  const { run } = await interactive();
  let current = true;
  guard.mockImplementation(async (params) => {
    await Promise.resolve();
    current = false;
    params.beforeRequest?.();
    throw new Error("Request dispatched after authority was revoked");
  });
  await expect(
    run({
      credentialOnly: true,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Login revoked");
        }
      },
    }),
  ).rejects.toThrow("Login revoked");
});
it.each([
  ["acme.ghe.com", undefined, true],
  ["github.com", undefined, false],
  ["acme.ghe.com", "github.com", false],
  ["github.com", "acme.ghe.com", false],
] as const)("logs into %s from %s", async (domain, from, credentialOnly) => {
  const publicLogin = domain === "github.com",
    plaintext = from === "github.com";
  const { login, prompter } = await interactive(
    true,
    publicLogin ? 0 : 1,
    plaintext ? "typed-tenant.ghe.com" : domain,
  );
  deviceFetch(domain, "connected-token");
  const result = await login(
    from
      ? publicLogin
        ? { config: domainConfig(from) }
        : { env: { COPILOT_GITHUB_DOMAIN: domain }, secretInputMode: "plaintext" }
      : { credentialOnly, isRemote: true, existingProfiles: undefined },
  );
  noCalls(prompter.confirm, runtimeAuth);
  expect(result?.profiles).toEqual([
    plaintext
      ? { profileId: PROFILE, credential: tokenProfile("connected-token") }
      : storedToken("connected-token"),
  ]);
  expect(result?.defaultModel).toBe(credentialOnly ? undefined : STARTER);
  expect(result?.configPatch).toStrictEqual(
    publicLogin ? (from ? domainConfig() : undefined) : domainConfig(domain),
  );
  if (plaintext) {
    noCalls(prompter.text);
  }
  if (publicLogin && from) {
    const [message] = expectDefined(
      prompter.note.mock.calls.find(([, title]) => title === "Authorize GitHub Copilot"),
      "device-code note",
    );
    expect(markdownToIR(message, { linkify: false }).links.map(({ href }) => href)).toEqual([
      "https://github.com/login/device",
    ]);
    expect(message).toContain("\nCode: ABCD-1234\n");
  }
});
it("retains same-tenant auth when live discovery fails", async () => {
  starterModel.mockRejectedValueOnce(new Error("catalog unavailable"));
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
    config: domainConfig("acme.ghe.com"),
    secretInputMode: "plaintext",
  });
  expect(prompter.confirm).toHaveBeenCalled();
  expect(result?.profiles).toEqual([authorized]);
  expect(result?.notes).toEqual([expect.stringContaining("authentication succeeded")]);
  expect(result?.defaultModel).toBeUndefined();
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
it.each(["reference", "existing", "primary", "enterprise", "public"] as const)(
  "onboards %s credentials",
  async (mode) => {
    const modelId = "github-copilot/gpt-5.4",
      primary = mode === "primary" ? modelId : STARTER;
    const model =
      mode === "existing"
        ? undefined
        : { fallbacks: ["openai/gpt-5.4"], ...(mode === "primary" ? { primary } : {}) };
    const models = mode === "existing" ? undefined : { [modelId]: { label: "Existing" } };
    const before = structuredClone({ model, models });
    const tokenRef = { source: "env", provider: "default", id: "COPILOT_GITHUB_TOKEN" };
    if (mode === "public" || mode === "enterprise") {
      vi.stubEnv("COPILOT_GITHUB_DOMAIN", mode === "public" ? "github.com" : "acme.ghe.com");
    }
    const token = mode === "reference" || mode === "existing" ? undefined : "ghu_test";
    const { dir, run } = await onboard(token, {
      config: {
        agents: mode === "existing" ? undefined : { defaults: { model, models } },
        ...(mode === "public" ? domainConfig("acme.ghe.com") : {}),
      },
      ...(mode === "reference"
        ? {
            opts: { secretInputMode: "ref" },
            resolveApiKey: vi.fn(async () => ({
              key: "ghu_from_env",
              source: "env",
              envVarName: tokenRef.id,
            })),
          }
        : {}),
    });
    if (mode === "existing") {
      writeExisting(dir);
    }
    mockRuntimeAuth("ghu_test", "https://api.individual.githubcopilot.com");
    const result = await run();
    expect(domainOf(result)).toBe(mode === "enterprise" ? "acme.ghe.com" : undefined);
    expect(result?.agents?.defaults?.model).toEqual({ ...before.model, primary });
    expect(result?.agents?.defaults?.models?.[modelId]).toEqual(before.models?.[modelId]);
    expect(result?.auth?.profiles?.[PROFILE]).toEqual({ provider: ID, mode: "token" });
    expect(readToken(dir)).toEqual(
      mode === "reference"
        ? { type: "token", provider: ID, tokenRef }
        : tokenProfile(mode === "existing" ? "existing-token" : "ghu_test"),
    );
    if (mode === "primary") {
      noCalls(starterModel);
      expect(runtimeAuth).toHaveBeenCalledWith(
        expect.objectContaining({ githubToken: "ghu_test" }),
      );
    }
  },
);
it("rejects missing onboarding credentials", async () => {
  const { dir, run } = await onboard();
  await expect(run()).rejects.toThrow("Missing --github-copilot-token");
  expect(ensureAuthProfileStore(dir).profiles).toEqual({});
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
it.each([
  [null, "cannot be used with --secret-input-mode ref"],
  [{ key: "synthetic-credential", source: "env" }, "requires an explicit environment variable"],
] as const)("rejects invalid reference %j before persistence", async (resolved, error) => {
  const { dir, run } = await onboard(undefined, {
    opts: { githubCopilotToken: "synthetic-credential", secretInputMode: "ref" },
    resolveApiKey: vi.fn(async () => resolved),
  });
  await expect(run()).rejects.toThrow(error);
  expect(ensureAuthProfileStore(dir).profiles).toEqual({});
});
