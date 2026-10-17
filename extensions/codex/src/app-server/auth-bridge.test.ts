import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertAuthProfile, upsertAuthProfileAsync } from "openclaw/plugin-sdk/provider-auth";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, expect, it as baseIt, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile as applyAuth,
  bridgeCodexAppServerStartOptions as bridgeStart,
  refreshCodexAppServerAuthTokens as refreshTokens,
  resolveCodexAppServerAuthAccountCacheKey as authCacheKey,
  resolveCodexAppServerHomeDir as codexHomeDir,
  resolveCodexAppServerPreparedAuthHandoff as prepareHandoff,
  resolveCodexAppServerPreparedAuthProfileSnapshot as prepareSnapshot,
} from "./auth-bridge.js";
import {
  fingerprintTokenAuthProfileCacheKey,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerPreparedApiKeyCacheKey,
} from "./auth-cache-key.js";
import {
  ensureCodexAppServerClientRuntime,
  recordCodexAppServerAuthHandoff,
} from "./client-runtime.js";
import { reconcileCodexComputerUseStartArtifacts } from "./computer-use-artifacts.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import { createClientHarness } from "./test-support.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const agentDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-");

const it = baseIt.extend<{ agentDir: string }>({
  agentDir: async ({ task: _task }, use) => {
    await use(agentDirs.make());
  },
});

const oauth = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

it("keeps subscription-sharing OAuth in the host and hands native Codex only an isolated placeholder", async () => {
  const profileId = "openai:token-sharing:test";
  const credential = {
    type: "oauth" as const,
    provider: "openai",
    authFlow: "chatgpt-token-sharing",
    access: "synthetic-scoped-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 60_000,
    issuer: "https://auth.openai.com",
    clientId: "synthetic-client",
    idToken: `header.${Buffer.from(JSON.stringify({ sub: "synthetic-subject" })).toString("base64url")}.signature`,
  };
  const params = {
    authRequirement: "api-key" as const,
    authProfileId: profileId,
    resolvedApiKey: credential.access,
    authProfileStore: { version: 1, profiles: { [profileId]: credential } },
    homeScope: "agent" as const,
    subscriptionProfileRequiredError: "required",
    subscriptionProfileUnusableError: "unusable",
  };
  const handoff = await prepareHandoff(params);
  expect(handoff.authProfileId).toBe(profileId);
  expect(handoff.preparedAuth?.kind).toBe("profile");
  if (handoff.preparedAuth?.kind !== "profile") {
    throw new Error("expected profile handoff");
  }
  expect(handoff.preparedAuth.snapshot).toMatchObject({
    inferenceAuth: "host-oauth",
    loginParams: { type: "apiKey" },
  });
  expect(JSON.stringify(handoff.preparedAuth.snapshot)).not.toContain(credential.access);
  expect(handoff.preparedAuth.snapshot).not.toHaveProperty("chatgptAccountId");
  const h = createClientHarness();
  try {
    const applying = applyAuth({
      client: h.client,
      preparedAuth: handoff.preparedAuth,
      authRequirement: "api-key",
      startOptions: {
        transport: "stdio",
        command: "codex",
        args: [],
        homeScope: "agent",
        headers: {},
      },
    });
    const login = JSON.parse(await h.waitForWrite(0));
    expect(login.method).toBe("account/login/start");
    expect(login.params).toEqual(handoff.preparedAuth.snapshot?.loginParams);
    expect(JSON.stringify(login)).not.toContain(credential.access);
    h.send({ id: login.id, result: { type: "apiKey" } });
    await applying;
  } finally {
    h.client.close();
  }
  await expect(prepareHandoff({ ...params, homeScope: "user" })).rejects.toThrow("isolated home");
  await expect(prepareHandoff({ ...params, requirePreparedAuth: true })).rejects.toThrow(
    "managed local",
  );
});

type MockDesktopCandidate = ReturnType<typeof resolveMacOSDesktopCodexAppPathCandidates>[number];
const desktop = vi.hoisted(() => ({
  cache: vi.fn<(_params: { forceRefresh?: boolean }) => Promise<boolean>>(async () => false),
  marketplace: vi.fn<(_params?: unknown) => Promise<string | undefined>>(async () => undefined),
  service: vi.fn(async (_params?: unknown) => ({
    status: "already_current" as const,
    changed: false,
  })),
  marketplaceSource: vi.fn<
    (params: {
      candidates?: readonly MockDesktopCandidate[];
    }) => Promise<MockDesktopCandidate | undefined>
  >(async (params) => params.candidates?.[0]),
  serviceSource: vi.fn<
    (params: { sourceAppCandidates?: readonly string[] }) => Promise<string | undefined>
  >(async (params) => params.sourceAppCandidates?.[0]),
}));

const providerRuntime = vi.hoisted(() => ({
  formatKey: vi.fn(),
  refresh: vi.fn(async (params: { provider?: string; context: { refresh: string } }) => {
    const refreshed = await oauth.refresh(params.context.refresh);
    return refreshed
      ? {
          ...params.context,
          ...refreshed,
          type: "oauth",
          provider: "openai",
        }
      : undefined;
  }),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  const { saveAuthProfileStore } = actual;
  return {
    ...actual,
    resolveApiKeyForProfile: async (
      params: Parameters<typeof actual.resolveApiKeyForProfile>[0],
    ) => {
      const credential = params.store.profiles[params.profileId];
      if (!credential) {
        return null;
      }
      if (credential.type === "api_key" || credential.type === "token") {
        const raw = credential.type === "api_key" ? credential.key : credential.token;
        const ref = credential.type === "api_key" ? credential.keyRef : credential.tokenRef;
        const apiKey = raw?.trim() || (ref?.source === "env" ? process.env[ref.id]?.trim() : "");
        return apiKey
          ? {
              apiKey,
              provider: credential.provider,
              ...(credential.type === "token" ? { email: credential.email } : {}),
            }
          : null;
      }
      if (credential.type !== "oauth") {
        return null;
      }
      let oauthCredential = credential;
      if (params.forceRefresh || (oauthCredential.expires ?? 0) <= Date.now()) {
        const refreshed = await providerRuntime.refresh({
          provider: oauthCredential.provider,
          context: oauthCredential,
        });
        if (refreshed?.access) {
          const refreshedCredential = refreshed as typeof oauthCredential;
          params.validateOAuthCredential?.(refreshedCredential);
          oauthCredential = refreshedCredential;
          params.store.profiles[params.profileId] = oauthCredential;
          if (params.agentDir || process.env.OPENCLAW_STATE_DIR) {
            saveAuthProfileStore(params.store, params.agentDir);
          }
        }
      } else {
        params.validateOAuthCredential?.(oauthCredential);
      }
      const formatted = await providerRuntime.formatKey({
        provider: oauthCredential.provider,
        context: oauthCredential,
      });
      const apiKey =
        typeof formatted === "string" && formatted ? formatted : oauthCredential.access;
      if (!apiKey) {
        return null;
      }
      const result = { apiKey, provider: oauthCredential.provider, email: oauthCredential.email };
      Object.defineProperty(result, "credential", { value: oauthCredential });
      return result;
    },
    refreshOAuthCredentialForRuntime: async (
      params: Parameters<typeof actual.refreshOAuthCredentialForRuntime>[0],
    ) => {
      const refreshed = await providerRuntime.refresh({
        provider: params.credential.provider,
        context: params.credential,
      });
      return refreshed
        ? {
            ...params.credential,
            ...refreshed,
            type: "oauth" as const,
          }
        : null;
    },
  };
});

vi.mock("./computer-use-service.js", () => ({
  ensureCodexComputerUseServiceApp: desktop.service,
  resolveCodexComputerUseServiceAppSourcePath: desktop.serviceSource,
}));

vi.mock("./computer-use-marketplace.js", () => ({
  ensureCodexManagedBundledMarketplace: desktop.marketplace,
  resolveCodexManagedBundledMarketplaceSource: desktop.marketplaceSource,
}));

vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache: desktop.cache,
}));

vi.mock("./desktop-app-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktop-app-paths.js")>();
  return {
    ...actual,
    resolveMacOSDesktopCodexAppPathCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexAppPathCandidates(platform ?? "darwin"),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeAuthProfileStoreSnapshots();
  oauth.refresh.mockReset();
  providerRuntime.formatKey.mockReset();
  providerRuntime.refresh.mockClear();
  desktop.service.mockClear();
  desktop.marketplace.mockClear();
  desktop.cache.mockReset();
  desktop.cache.mockResolvedValue(false);
  desktop.marketplaceSource.mockReset();
  desktop.marketplaceSource.mockImplementation(async (params) => params.candidates?.[0]);
  desktop.serviceSource.mockReset();
  desktop.serviceSource.mockImplementation(
    async (params: { sourceAppCandidates?: readonly string[] }) => params.sourceAppCandidates?.[0],
  );
});

function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource: "resolved-managed",
    args: ["app-server"],
    headers: { authorization: "Bearer dev-token" },
    ...overrides,
  };
}

const MANAGED_AUTH_ARGS = [
  "-c",
  'cli_auth_credentials_store="ephemeral"',
  "-c",
  "thread_unload_delay_secs=0",
  "app-server",
];

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

type AuthProfileStore = ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>;
type AuthProfileCredential = AuthProfileStore["profiles"][string];

type OAuthProfile = Extract<AuthProfileCredential, { type: "oauth" }>;

type AccountTokens = { access: string; refresh: string; expires: number; accountId: string };

function oauthTokens<T extends Partial<OAuthProfile>>(prefix: string, overrides: T) {
  return {
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

function refreshResult(accessToken: string, chatgptAccountId: string) {
  return { accessToken, chatgptAccountId, chatgptPlanType: null };
}

function sendTokenRefresh(harness: ReturnType<typeof createClientHarness>, id: string) {
  harness.send({
    id,
    method: "account/chatgptAuthTokens/refresh",
    params: { reason: "unauthorized", previousAccountId: "account-a" },
  });
}

function loginRequest(type = "chatgptAuthTokens") {
  return vi.fn(async () => ({ type }));
}

function fallbackRequest() {
  return vi.fn(async (method: string) =>
    method === "account/read" ? { account: null, requiresOpenaiAuth: true } : { type: "apiKey" },
  );
}

function oauthProfile(
  prefix: string,
  overrides: Partial<Omit<OAuthProfile, "type" | "provider">> = {},
): OAuthProfile {
  return {
    type: "oauth",
    provider: "openai",
    // Fresh fixtures must outlive the proactive OAuth refresh window.
    ...oauthTokens(prefix, { expires: Date.now() + 24 * 60 * 60_000, ...overrides }),
  };
}

function applyApiKeyFallback(
  request: ReturnType<typeof fallbackRequest>,
  agentDir: string,
  startOptions = createStartOptions(),
) {
  return applyAuth({
    client: { request } as never,
    agentDir,
    authRequirement: "api-key",
    startOptions,
  });
}

function reconcileArtifacts(
  agentDir: string,
  overrides: Partial<Parameters<typeof reconcileCodexComputerUseStartArtifacts>[0]> = {},
) {
  return reconcileCodexComputerUseStartArtifacts({
    agentDir,
    startOptions: createStartOptions(),
    pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    ...overrides,
  });
}

function profileStore<T extends AuthProfileCredential>(credential: T) {
  return { version: 1, profiles: { "openai:work": credential } };
}

function profileParams(agentDir: string, authProfileStore?: AuthProfileStore) {
  return { agentDir, authProfileId: "openai:work", authProfileStore };
}

function authFixture(
  agentDir: string,
  store?: AuthProfileStore,
  request: ReturnType<typeof vi.fn> = loginRequest(),
) {
  const params = profileParams(agentDir, store);
  return {
    request,
    apply: (extra: Partial<Parameters<typeof applyAuth>[0]> = {}) =>
      applyAuth({ client: { request } as never, ...params, ...extra }),
    refresh: (extra: Partial<Parameters<typeof refreshTokens>[0]> = {}) =>
      refreshTokens({ ...params, ...extra }),
    cache: () => authCacheKey(params),
    snapshot: () => prepareSnapshot(params),
  };
}

function persistedStore(agentDir: string, credential: AuthProfileCredential) {
  persistProfile(agentDir, credential);
  return loadAuthProfileStoreForSecretsRuntime(agentDir);
}

function authHandoff(access: string, chatgptAccountId: string) {
  return { accessFingerprint: fingerprintTokenAuthProfileCacheKey(access), chatgptAccountId };
}

function readProfile(agentDir?: string) {
  return loadAuthProfileStoreForSecretsRuntime(agentDir).profiles["openai:work"];
}

function persistProfile(agentDir: string, credential: AuthProfileCredential): void {
  upsertAuthProfile({ agentDir, profileId: "openai:work", credential });
}

function expectApiKeyLogin(
  request: ReturnType<typeof vi.fn>,
  apiKey: string,
  readAccount = false,
): void {
  const options = expect.anything();
  const login = ["account/login/start", { type: "apiKey", apiKey }, options];
  if (readAccount) {
    expect(request).toHaveBeenNthCalledWith(1, "account/read", { refreshToken: false }, options);
    expect(request).toHaveBeenNthCalledWith(2, ...login);
  } else {
    expect(request).toHaveBeenCalledWith(...login);
  }
}

function expectTokenLogin(
  request: ReturnType<typeof vi.fn>,
  accessToken: string,
  chatgptAccountId: string,
  chatgptPlanType: string | null = null,
  count?: number,
): void {
  const call = [
    "account/login/start",
    { type: "chatgptAuthTokens", accessToken, chatgptAccountId, chatgptPlanType },
    expect.anything(),
  ];
  if (count === undefined) {
    expect(request).toHaveBeenCalledWith(...call);
  } else {
    expect(request.mock.calls).toEqual(Array.from({ length: count }, () => call));
  }
}

function chatgptAccessToken(accountId: string, subject?: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        ...(subject ? { sub: subject } : {}),
      }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");
}

async function writeCliAuth(codexHome: string, auth: object): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, "auth.json"), `${JSON.stringify(auth)}\n`);
}

function writeCodexCliAuthFile(codexHome: string) {
  return writeCliAuth(codexHome, {
    tokens: {
      access_token: "cli-access-token",
      refresh_token: "cli-refresh-token",
      account_id: "account-cli",
    },
  });
}

async function writeCodexCliApiKeyAuthFile(codexHome: string, key = "cli-auth-json-api-key") {
  return writeCliAuth(codexHome, { auth_mode: "apikey", OPENAI_API_KEY: key });
}

it("rejects unimported agent auth without API-key fallback", async ({ agentDir }) => {
  const codexHome = codexHomeDir(agentDir);
  await writeCodexCliAuthFile(codexHome);
  vi.stubEnv("CODEX_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("CODEX_HOME", "");
  vi.stubEnv("HOME", path.join(agentDir, "empty-home"));

  await expect(
    bridgeStart({
      startOptions: createStartOptions({ headers: {}, commandSource: "managed" }),
      agentDir,
      agentId: "research",
      authRequirement: "api-key",
    }),
  ).rejects.toMatchObject({
    name: "AgentHarnessPreflightError",
    message: expect.stringContaining(
      "openclaw migrate apply codex --from <codex-home> --agent research --include-secrets --item auth:openai --yes",
    ),
  });
});

it("preserves API-key fallback over a stale agent auth file", async ({ agentDir }) => {
  await writeCodexCliAuthFile(codexHomeDir(agentDir));
  vi.stubEnv("CODEX_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "ambient-api-key");

  const startOptions = await bridgeStart({
    startOptions: createStartOptions({ env: { OPENAI_API_KEY: "platform-api-key" } }),
    agentDir,
    agentId: "research",
    authRequirement: "api-key",
  });
  expect(startOptions).toMatchObject({
    args: MANAGED_AUTH_ARGS,
    env: { CODEX_HOME: codexHomeDir(agentDir) },
  });

  const request = fallbackRequest();
  await applyApiKeyFallback(request, agentDir, startOptions);
  expectApiKeyLogin(request, "platform-api-key", true);
});

it("rejects a desktop candidate whose exact marketplace is unavailable", async ({ agentDir }) => {
  desktop.marketplaceSource.mockResolvedValueOnce(undefined);

  await expect(
    reconcileArtifacts(agentDir, {
      startOptions: createStartOptions({
        command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      }),
    }),
  ).rejects.toMatchObject({
    code: "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE",
  });
  expect(desktop.service).not.toHaveBeenCalled();
  expect(desktop.marketplace).not.toHaveBeenCalled();
});

it.each([
  { marketplaceSource: "file:///tmp/custom-marketplace" },
  { marketplacePath: "/tmp/custom-marketplace/marketplace.json" },
  { marketplaceName: "custom-marketplace" },
])(
  "keeps an exact desktop candidate with configured marketplace selection",
  async (selector, { agentDir }) => {
    await expect(
      reconcileCodexComputerUseStartArtifacts({
        startOptions: createStartOptions({
          command: "/Applications/ChatGPT.app/Contents/Resources/codex",
        }),
        agentDir,
        pluginConfig: {
          computerUse: { enabled: true, autoInstall: true, ...selector },
        },
      }),
    ).resolves.toBeUndefined();
    expect(desktop.marketplace).not.toHaveBeenCalled();
    expect(desktop.service).toHaveBeenCalledOnce();
  },
);

it("classifies native client provisioning failures as harness preflight", async () => {
  desktop.marketplace.mockResolvedValueOnce("/managed/openai-bundled");
  desktop.service.mockRejectedValueOnce(new Error("copy failed"));

  await expect(reconcileArtifacts("/tmp/openclaw-codex-computer-use-failed")).rejects.toMatchObject(
    { name: "AgentHarnessPreflightError", scope: "harness" },
  );
});

it("refreshes shared cache once per selected desktop source generation", async ({ agentDir }) => {
  desktop.cache.mockResolvedValue(true);
  const startOptions = createStartOptions({
    command: "/Applications/ChatGPT.app/Contents/Resources/codex",
  });
  const pluginConfig = {
    computerUse: {
      enabled: true,
      autoInstall: false,
      pluginCacheMode: "shared" as const,
    },
  };

  for (const desktopGeneration of [
    { epoch: 1, fingerprint: "desktop-x" },
    { epoch: 1, fingerprint: "desktop-x" },
    { epoch: 2, fingerprint: "desktop-y" },
  ]) {
    await reconcileCodexComputerUseStartArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration,
    });
  }

  expect(desktop.cache.mock.calls.map(([params]) => params.forceRefresh)).toEqual([
    true,
    false,
    true,
  ]);
  expect(desktop.service).not.toHaveBeenCalled();
  expect(desktop.marketplace).not.toHaveBeenCalled();
});

it("checks caller authority after queued artifact work", async ({ agentDir }) => {
  const firstMarketplaceStarted = createDeferred<void>();
  const releaseFirstMarketplace = createDeferred<void>();
  let activeMarketplaceCalls = 0;
  let maxActiveMarketplaceCalls = 0;
  desktop.marketplace
    .mockImplementationOnce(async () => {
      activeMarketplaceCalls += 1;
      maxActiveMarketplaceCalls = Math.max(maxActiveMarketplaceCalls, activeMarketplaceCalls);
      firstMarketplaceStarted.resolve();
      try {
        await releaseFirstMarketplace.promise;
        return "/managed/openai-bundled";
      } finally {
        activeMarketplaceCalls -= 1;
      }
    })
    .mockImplementationOnce(async () => {
      activeMarketplaceCalls += 1;
      maxActiveMarketplaceCalls = Math.max(maxActiveMarketplaceCalls, activeMarketplaceCalls);
      activeMarketplaceCalls -= 1;
      return "/managed/openai-bundled";
    });
  let callerCurrent = true;
  const startOptions = createStartOptions();
  const first = reconcileArtifacts(agentDir, {
    startOptions,
    desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
    assertCurrent: () => {
      if (!callerCurrent) {
        throw new Error("caller authority revoked");
      }
    },
  });
  await firstMarketplaceStarted.promise;
  callerCurrent = false;
  const second = reconcileArtifacts(agentDir, {
    startOptions,
    desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
  });
  releaseFirstMarketplace.resolve();

  await expect(first).rejects.toThrow("caller authority revoked");
  await expect(second).resolves.toBeUndefined();
  expect(maxActiveMarketplaceCalls).toBe(1);
  expect(desktop.service).toHaveBeenCalledTimes(1);
});

it.each([
  { transport: "stdio" as const, homeScope: "agent" as const, proxy: false, managed: true },
  { transport: "stdio" as const, homeScope: "user" as const, proxy: false, managed: false },
  { transport: "stdio" as const, homeScope: "agent" as const, proxy: true, managed: false },
  { transport: "websocket" as const, homeScope: "agent" as const, proxy: false, managed: false },
  { transport: "unix" as const, homeScope: "agent" as const, proxy: false, managed: false },
])(
  "owns unload retention only for managed local starts: $transport/$homeScope/proxy=$proxy",
  async ({ transport, homeScope, proxy, managed }, { agentDir }) => {
    vi.stubEnv("CODEX_HOME", path.join(agentDir, "native-home"));
    const startOptions = createStartOptions({
      transport,
      homeScope,
      args: ["-c", "thread_unload_delay_secs=25", "app-server", ...(proxy ? ["proxy"] : [])],
    });
    const bridged = await bridgeStart({ startOptions, agentDir, authProfileId: null });
    expect(bridged.args).toEqual(
      managed
        ? ["-c", "thread_unload_delay_secs=25", "-c", "thread_unload_delay_secs=0", "app-server"]
        : startOptions.args,
    );
  },
);

it("uses the native user Codex home for coexistence mode", async ({ agentDir: root }) => {
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(root, "user-codex-home");
  vi.stubEnv("CODEX_HOME", codexHome);
  const startOptions = createStartOptions({ homeScope: "user" });
  await expect(bridgeStart({ startOptions, agentDir, authProfileId: null })).resolves.toEqual({
    ...startOptions,
    env: { CODEX_HOME: codexHome },
  });
  await fs.access(codexHome);
  await expectPathMissing(codexHomeDir(agentDir));
  await reconcileArtifacts(agentDir, { startOptions });
  expect(desktop.service).not.toHaveBeenCalled();
  expect(desktop.marketplace).not.toHaveBeenCalled();
});

it("preserves explicit CODEX_HOME and HOME overrides", async ({ agentDir }) => {
  const codexHome = path.join(agentDir, "custom-codex-home");
  const nativeHome = path.join(agentDir, "custom-native-home");
  const startOptions = createStartOptions({
    env: { CODEX_HOME: codexHome, HOME: nativeHome, EXISTING: "1" },
    clearEnv: ["CODEX_HOME", "HOME", "FOO"],
  });

  await expect(
    bridgeStart({
      startOptions,
      agentDir,
    }),
  ).resolves.toEqual({
    ...startOptions,
    args: MANAGED_AUTH_ARGS,
    env: {
      CODEX_HOME: codexHome,
      HOME: nativeHome,
      EXISTING: "1",
    },
    clearEnv: ["FOO"],
  });
  await fs.access(codexHome);
  await fs.access(nativeHome);
  expect(startOptions.clearEnv).toEqual(["CODEX_HOME", "HOME", "FOO"]);
  await reconcileArtifacts(agentDir, { startOptions });
  expect(desktop.service).not.toHaveBeenCalled();
  expect(desktop.marketplace).not.toHaveBeenCalled();
});

it("clears inherited keys for default subscription auth", async ({ agentDir }) => {
  const startOptions = createStartOptions({
    env: { EXISTING: "1" },
    clearEnv: ["CODEX_HOME", "HOME", "FOO"],
  });

  upsertAuthProfile({
    agentDir,
    profileId: "openai:default",
    credential: oauthProfile("test", {
      access: "access-token",
      refresh: "refresh-token",
      accountId: "account-123",
    }),
  });

  await expect(
    bridgeStart({
      startOptions,
      agentDir,
    }),
  ).resolves.toEqual({
    ...startOptions,
    args: MANAGED_AUTH_ARGS,
    env: {
      EXISTING: "1",
      CODEX_HOME: codexHomeDir(agentDir),
    },
    clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY"],
  });
  expect(startOptions.clearEnv).toEqual(["CODEX_HOME", "HOME", "FOO"]);
  await expectPathMissing(path.join(agentDir, "harness-auth"));
});

it.each(["api-key", "profile"] as const)(
  "clears ambient auth before prepared %s startup",
  async (authKind, { agentDir }) => {
    const startOptions = createStartOptions({ clearEnv: ["FOO", "OPENAI_API_KEY"] });
    const bridged = await bridgeStart({
      startOptions,
      agentDir,
      authProfileId: authKind === "api-key" ? null : "openai:prepared",
      preparedAuth:
        authKind === "api-key"
          ? { kind: "api-key", apiKey: "prepared-platform-key" }
          : {
              kind: "profile",
              profileId: "openai:prepared",
              store: { version: 1, profiles: { "openai:prepared": oauthProfile("prepared") } },
            },
    });
    expect(bridged).toEqual({
      ...startOptions,
      args: MANAGED_AUTH_ARGS,
      env: { CODEX_HOME: codexHomeDir(agentDir) },
      clearEnv: ["FOO", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
    });
    const spawnEnv = resolveCodexAppServerSpawnEnv(bridged, {
      FOO: "ambient",
      CODEX_API_KEY: "ambient-codex-key",
      OPENAI_API_KEY: "ambient-openai-key",
      CODEX_ACCESS_TOKEN: "ambient-access-token",
    });
    expect(spawnEnv).toEqual({ CODEX_HOME: codexHomeDir(agentDir) });
  },
);

it("applies a prepared API-key handoff without selecting an available OAuth profile", async () => {
  const authProfileStore: AuthProfileStore = profileStore(
    oauthProfile("test", {
      access: "subscription-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    }),
  );
  const handoff = await prepareHandoff({
    authRequirement: "api-key",
    resolvedApiKey: "  prepared-platform-key  ",
    authProfileId: "openai:work",
    authProfileStore,
    homeScope: "agent",
    subscriptionProfileRequiredError: "unused",
    subscriptionProfileUnusableError: "unused",
  });
  expect(handoff).toEqual({
    nativeAuthProfile: false,
    preparedAuth: { kind: "api-key", apiKey: "prepared-platform-key" },
  });
  if (handoff.preparedAuth?.kind !== "api-key") {
    throw new Error("Expected API-key handoff");
  }
  const { request, apply } = authFixture(
    "/tmp/openclaw-agent",
    authProfileStore,
    loginRequest("apiKey"),
  );
  await apply({
    authProfileId: null,
    preparedAuth: handoff.preparedAuth,
  });
  expect(request).toHaveBeenCalledOnce();
  expectApiKeyLogin(request, "prepared-platform-key");
  expect(oauth.refresh).not.toHaveBeenCalled();
});

it("isolates prepared token handoffs sharing the same ChatGPT workspace", async () => {
  const snapshotFor = async (token: string) => {
    const authProfileStore = profileStore({ type: "token", provider: "openai", token });
    const handoff = await prepareHandoff({
      authRequirement: "subscription",
      authProfileId: "openai:work",
      authProfileStore,
      agentDir: "/tmp/openclaw-agent",
      homeScope: "agent",
      subscriptionProfileRequiredError: "profile required",
      subscriptionProfileUnusableError: "profile unusable",
    });
    expect(handoff).toMatchObject({
      authProfileId: "openai:work",
      nativeAuthProfile: true,
      preparedAuth: { kind: "profile", profileId: "openai:work", store: authProfileStore },
    });
    if (handoff.preparedAuth?.kind !== "profile") {
      throw new Error("Expected profile handoff");
    }
    expect(handoff.preparedAuth.snapshot?.loginParams).toMatchObject({
      type: "chatgptAuthTokens",
      accessToken: token,
      chatgptAccountId: "shared-account",
    });
    return handoff.preparedAuth.snapshot;
  };
  const firstToken = chatgptAccessToken("shared-account", "first-subject");
  const secondToken = chatgptAccessToken("shared-account", "second-subject");
  const first = await snapshotFor(firstToken);
  const second = await snapshotFor(secondToken);
  expect(first?.secretFreeCacheKey).toMatch(/^shared-account:token:sha256:[a-f0-9]{64}$/u);
  expect(second?.secretFreeCacheKey).toMatch(/^shared-account:token:sha256:[a-f0-9]{64}$/u);
  expect(first?.secretFreeCacheKey).not.toBe(second?.secretFreeCacheKey);
  expect(first?.secretFreeCacheKey).not.toContain(firstToken);
  expect(second?.secretFreeCacheKey).not.toContain(secondToken);
});

it("preserves explicit API-key profiles with JWT-like keys", async ({ agentDir }) => {
  const startOptions = createStartOptions({ clearEnv: ["FOO"] });
  const tokenLikeKey = "eyJhbGciOiJub25l.eyJzdWIiOiJjb2RleCJ9.signature123456";

  persistProfile(agentDir, {
    type: "api_key",
    provider: "openai",
    key: tokenLikeKey,
  });

  await expect(
    bridgeStart({
      startOptions,
      ...profileParams(agentDir),
    }),
  ).resolves.toEqual({
    ...startOptions,
    args: MANAGED_AUTH_ARGS,
    env: { CODEX_HOME: codexHomeDir(agentDir) },
  });
  const { request, apply } = authFixture(agentDir, undefined, loginRequest("apiKey"));
  await expect(apply()).resolves.toBeUndefined();
  expectApiKeyLogin(request, tokenLikeKey);
});

it("fingerprints token auth-profile secret refs", async ({ agentDir }) => {
  persistProfile(agentDir, {
    type: "token",
    provider: "openai",
    tokenRef: { source: "env", provider: "default", id: "OPENAI_CODEX_TEST_TOKEN" },
    email: "codex@example.test",
  });
  vi.stubEnv("OPENAI_CODEX_TEST_TOKEN", "first-ref-token");
  const first = await authCacheKey(profileParams(agentDir));

  vi.stubEnv("OPENAI_CODEX_TEST_TOKEN", "second-ref-token");
  const second = await authCacheKey(profileParams(agentDir));

  expect(first).toMatch(/^codex@example\.test:token:sha256:[a-f0-9]{64}$/);
  expect(second).toMatch(/^codex@example\.test:token:sha256:[a-f0-9]{64}$/);
  expect(second).not.toBe(first);
  expect(first).not.toContain("first-ref-token");
  expect(second).not.toContain("second-ref-token");
});

it.each(["credential refresh", "overload retry"] as const)(
  "does not send native login after its caller retires during %s",
  async (phase, { agentDir }) => {
    const refreshing = createDeferred<void>();
    const release = createDeferred<void>();
    oauth.refresh.mockImplementationOnce(async () => {
      refreshing.resolve();
      await release.promise;
      return oauthTokens("test", {
        access: chatgptAccessToken("scoped-account"),
        refresh: "refreshed-token",
        accountId: "scoped-account",
      });
    });
    let current = true;
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const message: { id: number } = JSON.parse(line);
        if (phase === "overload retry" && current) {
          current = false;
          send({ id: message.id, error: { code: -32_001, message: "Server overloaded" } });
        } else {
          send({ id: message.id, result: { type: "chatgptAuthTokens" } });
        }
      },
    });
    const retired = new Error("native login caller retired");
    const authProfileStore = profileStore(
      oauthProfile("test", {
        access: "expired-access",
        refresh: "refresh-token",
        expires: Date.now() - 60_000,
        accountId: "scoped-account",
      }),
    );
    const run = authFixture(agentDir, authProfileStore).apply({
      client: harness.client,
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    });
    const rejection = expect(run).rejects.toBe(retired);
    try {
      await refreshing.promise;
      if (phase === "credential refresh") {
        current = false;
      }
      release.resolve();

      await rejection;
      expect(harness.writes.map((line) => JSON.parse(line).method)).toEqual(
        phase === "credential refresh" ? [] : ["account/login/start"],
      );
    } finally {
      release.resolve();
      harness.client.close();
    }
  },
);

it("rejects login after post-response retirement", async ({ agentDir }) => {
  let current = true;
  const harness = createClientHarness({
    onWrite: (line, send) => {
      const message = JSON.parse(line) as { id?: string | number };
      if (message.id !== undefined) {
        send({ id: message.id, result: { type: "chatgptAuthTokens" } });
        current = false;
      }
    },
  });
  try {
    persistProfile(
      agentDir,
      oauthProfile("test", {
        access: "access-token",
        refresh: "refresh-token",
        accountId: "account-a",
      }),
    );

    await expect(
      authFixture(agentDir).apply({
        client: harness.client,
        assertCurrent: () => {
          if (!current) {
            throw new Error("login owner retired");
          }
        },
      }),
    ).rejects.toThrow("login owner retired");

    expect(harness.writes).toHaveLength(1);
  } finally {
    harness.client.close();
  }
});

it("aligns persisted snapshots across forced rotations", async ({ agentDir }) => {
  const credential = oauthProfile("initial", {
    expires: Date.now() + 60 * 60_000,
    accountId: "rotating-account",
  });
  const authProfileStore = persistedStore(agentDir, credential);
  const currentCredential = {
    ...credential,
    refresh: "updated-refresh",
    expires: credential.expires + 60_000,
  };
  persistProfile(agentDir, currentCredential);
  oauth.refresh
    .mockImplementationOnce(async () => {
      expect(readProfile(agentDir)).toEqual(currentCredential);
      return oauthTokens("first-rotated", {});
    })
    .mockResolvedValueOnce(oauthTokens("second-rotated", {}));
  const { refresh } = authFixture(agentDir, authProfileStore);
  const first = await refresh({
    previousAccountId: "rotating-account",
    authHandoff: authHandoff(credential.access, "rotating-account"),
  });
  expect(first).toEqual(refreshResult("first-rotated-access", "rotating-account"));
  const second = await refresh();
  expect(second.accessToken).toBe("second-rotated-access");
  expect(oauth.refresh.mock.calls).toEqual([["updated-refresh"], ["first-rotated-refresh"]]);
  for (const profile of [authProfileStore.profiles["openai:work"], readProfile(agentDir)]) {
    expect(profile).toMatchObject({
      access: "second-rotated-access",
      refresh: "second-rotated-refresh",
    });
  }
});

it("reuses late persisted rotation on the next callback", async ({ agentDir }) => {
  vi.useFakeTimers();
  const lateRefresh = createDeferred<AccountTokens>();
  const refreshStarted = createDeferred<void>();
  oauth.refresh
    .mockImplementationOnce(() => {
      refreshStarted.resolve();
      return lateRefresh.promise;
    })
    .mockResolvedValueOnce(oauthTokens("duplicate", { accountId: "account-a" }));
  const harness = createClientHarness({
    onWrite: (line, send) => {
      const message = JSON.parse(line) as { id?: string | number; method?: string };
      if (message.method === "account/login/start" && message.id !== undefined) {
        send({ id: message.id, result: { type: "chatgptAuthTokens" } });
      }
    },
  });
  try {
    const authProfileStore = persistedStore(
      agentDir,
      oauthProfile("initial", { accountId: "account-a" }),
    );
    ensureCodexAppServerClientRuntime(harness.client, profileParams(agentDir, authProfileStore));
    recordCodexAppServerAuthHandoff(
      harness.client,
      await authFixture(agentDir, authProfileStore).apply({ client: harness.client }),
    );

    sendTokenRefresh(harness, "refresh-timeout");
    await refreshStarted.promise;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(JSON.parse(await harness.waitForWrite(1))).toMatchObject({
      id: "refresh-timeout",
      error: { message: expect.stringContaining("token refresh timed out") },
    });

    lateRefresh.resolve(
      oauthTokens("late", { expires: Date.now() + 24 * 60 * 60_000, accountId: "account-a" }),
    );
    await vi.waitFor(() =>
      expect(authProfileStore.profiles["openai:work"]).toMatchObject({
        access: "late-access",
        refresh: "late-refresh",
      }),
    );

    sendTokenRefresh(harness, "refresh-retry");
    expect(JSON.parse(await harness.waitForWrite(2))).toEqual({
      id: "refresh-retry",
      result: refreshResult("late-access", "account-a"),
    });
    expect(oauth.refresh).toHaveBeenCalledTimes(1);

    sendTokenRefresh(harness, "refresh-after-handoff");
    expect(JSON.parse(await harness.waitForWrite(3))).toEqual({
      id: "refresh-after-handoff",
      result: refreshResult("duplicate-access", "account-a"),
    });
    expect(oauth.refresh).toHaveBeenCalledTimes(2);
  } finally {
    harness.client.close();
    vi.useRealTimers();
  }
});

it.each(["scoped", "persisted"] as const)(
  "does not commit a different workspace from a forced %s refresh",
  async (ownership, { agentDir }) => {
    const persisted = ownership === "persisted";
    const credential = oauthProfile(
      "initial",
      persisted
        ? { access: chatgptAccessToken("account-a"), expires: Date.now() + 60 * 60_000 }
        : { accountId: "account-a" },
    );
    oauth.refresh.mockResolvedValueOnce(
      oauthTokens("other", {
        access: persisted ? chatgptAccessToken("account-b") : "other-access",
        expires: Date.now() + 24 * 60 * 60_000,
        accountId: "account-b",
      }),
    );
    if (persisted) {
      persistProfile(agentDir, credential);
    }
    const authProfileStore = persisted
      ? loadAuthProfileStoreForSecretsRuntime(agentDir)
      : profileStore(credential);
    await expect(
      authFixture(agentDir, authProfileStore).refresh({
        authHandoff: authHandoff(credential.access, "account-a"),
        previousAccountId: "account-a",
      }),
    ).rejects.toThrow("ChatGPT workspace changed during Codex token refresh");
    expect(persisted ? readProfile(agentDir) : authProfileStore.profiles["openai:work"]).toEqual(
      credential,
    );
  },
);

it.each(["callback conflict", "reselected workspace"] as const)(
  "rejects %s before refreshing a scoped credential",
  async (reason, { agentDir }) => {
    const conflicting = reason === "callback conflict";
    const credential = conflicting
      ? oauthProfile("opaque", { expires: Date.now() + 60 * 60_000 })
      : oauthProfile("workspace-b", { accountId: "account-b" });
    const authProfileStore = profileStore(credential);
    await expect(
      authFixture(agentDir, authProfileStore).refresh({
        authHandoff: authHandoff(
          conflicting ? credential.access : "workspace-a-access",
          "account-a",
        ),
        ...(conflicting ? { previousAccountId: "account-b" } : {}),
      }),
    ).rejects.toThrow("ChatGPT workspace changed before Codex token refresh");
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(authProfileStore.profiles["openai:work"]).toEqual(credential);
  },
);

it("does not replace a prepared persisted store changed during refresh", async ({ agentDir }) => {
  const refreshing = createDeferred<ReturnType<typeof oauthTokens>>();
  oauth.refresh.mockImplementationOnce(() => refreshing.promise);

  const authProfileStore = persistedStore(
    agentDir,
    oauthProfile("initial", { accountId: "initial-account" }),
  );

  const refresh = refreshTokens(profileParams(agentDir, authProfileStore));
  await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1));
  authProfileStore.profiles["openai:work"] = oauthProfile("replacement", {
    accountId: "replacement-account",
  });
  refreshing.resolve(oauthTokens("rotated", {}));

  await refresh;
  expect(authProfileStore.profiles["openai:work"]).toMatchObject({
    access: "replacement-access",
    refresh: "replacement-refresh",
    accountId: "replacement-account",
  });
});

it("returns validated refresh despite a persisted workspace switch", async ({ agentDir }) => {
  const initialAccess = chatgptAccessToken("workspace-a", "initial");
  const refreshedAccess = chatgptAccessToken("workspace-a", "refreshed");
  const replacementAccess = chatgptAccessToken("workspace-b", "replacement");
  oauth.refresh.mockResolvedValueOnce(oauthTokens("refreshed", { access: refreshedAccess }));
  providerRuntime.formatKey.mockImplementationOnce(async ({ context }) => {
    persistProfile(
      agentDir,
      oauthProfile("replacement", { access: replacementAccess, expires: Date.now() + 60_000 }),
    );
    return context.access;
  });

  persistProfile(
    agentDir,
    oauthProfile("initial", { access: initialAccess, expires: Date.now() - 60_000 }),
  );
  const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);

  const refreshed = await refreshTokens(profileParams(agentDir, authProfileStore));

  expect(refreshed).toMatchObject({
    accessToken: refreshedAccess,
    chatgptAccountId: "workspace-a",
  });
  expect(authProfileStore.profiles["openai:work"]).toMatchObject({
    access: refreshedAccess,
    refresh: "refreshed-refresh",
  });
  expect(readProfile(agentDir)).toMatchObject({
    access: replacementAccess,
    refresh: "replacement-refresh",
  });
});

it("keeps a runtime-external same-account OAuth profile scoped", async ({ agentDir }) => {
  const request = loginRequest();
  oauth.refresh.mockResolvedValueOnce(
    oauthTokens("scoped-refreshed", { accountId: "shared-account" }),
  );

  persistProfile(agentDir, oauthProfile("persisted", { accountId: "shared-account" }));
  const scopedCredential = oauthProfile("scoped", {
    access: "scoped-expired-access",
    expires: Date.now() - 60_000,
    accountId: "shared-account",
    chatgptPlanType: "pro",
  });
  const authProfileStore: AuthProfileStore = {
    version: 1,
    runtimeExternalProfileIds: ["openai:work"],
    runtimeExternalProfileIdsAuthoritative: true,
    profiles: {
      "openai:work": scopedCredential,
    },
  };

  await authFixture(agentDir, authProfileStore, request).apply();

  expect(oauth.refresh).toHaveBeenCalledWith("scoped-refresh");
  expectTokenLogin(request, "scoped-refreshed-access", "shared-account", "pro");
  expect(readProfile(agentDir)).toMatchObject({
    access: "persisted-access",
    refresh: "persisted-refresh",
    accountId: "shared-account",
  });
});

it("keeps changed-workspace clones scoped even when emails match", async ({ agentDir }) => {
  const request = loginRequest();
  const refreshedAccess = chatgptAccessToken("account-a", "refreshed");
  const replacementAccess = chatgptAccessToken("account-b");
  oauth.refresh.mockResolvedValueOnce(
    oauthTokens("account-a-refreshed", { access: refreshedAccess, accountId: "account-a" }),
  );

  persistProfile(
    agentDir,
    oauthProfile("account-a", {
      access: chatgptAccessToken("account-a", "expired"),
      expires: Date.now() - 60_000,
      email: "codex@example.test",
    }),
  );
  const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
  expect(authProfileStore.runtimePersistedProfileIds).toContain("openai:work");
  persistProfile(
    agentDir,
    oauthProfile("account-b", { access: replacementAccess, email: "codex@example.test" }),
  );
  replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: authProfileStore }]);

  await authFixture(agentDir, authProfileStore, request).apply();

  expect(oauth.refresh).toHaveBeenCalledWith("account-a-refresh");
  expectTokenLogin(request, refreshedAccess, "account-a");
  expect(readProfile(agentDir)).toMatchObject({
    access: replacementAccess,
    refresh: "account-b-refresh",
  });
});

it("coalesces scoped startup logins and validates each refresh waiter", async ({ agentDir }) => {
  const refresh = createDeferred<AccountTokens>();
  const started = createDeferred<void>();
  oauth.refresh.mockImplementationOnce(() => {
    started.resolve();
    return refresh.promise;
  });
  const credential = oauthProfile("expired", { expires: Date.now() - 60_000 });
  const authProfileStore: AuthProfileStore = profileStore(credential);

  const { request, apply, refresh: refreshAuth } = authFixture(agentDir, authProfileStore);
  const first = apply();
  const second = apply();
  const compatibleWaiter = refreshAuth({
    previousAccountId: "account-a",
  });
  const incompatibleWaiter = refreshAuth({
    authHandoff: authHandoff(credential.access, "account-b"),
  });
  const incompatibleRejection = expect(incompatibleWaiter).rejects.toThrow(
    "ChatGPT workspace changed during Codex token refresh",
  );
  await started.promise;

  refresh.resolve(oauthTokens("refreshed", { accountId: "account-a" }));

  await expect(Promise.all([first, second])).resolves.toEqual([
    authHandoff("refreshed-access", "account-a"),
    authHandoff("refreshed-access", "account-a"),
  ]);
  expectTokenLogin(request, "refreshed-access", "account-a", null, 2);
  await expect(compatibleWaiter).resolves.toEqual(refreshResult("refreshed-access", "account-a"));
  await incompatibleRejection;
  expect(oauth.refresh).toHaveBeenCalledTimes(1);
});

it("leaves native auth untouched when bridging is disabled", async ({ agentDir }) => {
  const { request, apply } = authFixture(
    agentDir,
    undefined,
    vi.fn(async () => ({ requiresOpenaiAuth: true })),
  );

  vi.stubEnv("OPENAI_API_KEY", "env-api-key");

  await apply({
    authProfileId: null,
    startOptions: createStartOptions(),
  });

  expect(request).not.toHaveBeenCalled();
});

it("pins remote profile login to its prepared SecretRef snapshot while live cache identity rotates", async () => {
  const authProfileStore = profileStore({
    type: "api_key",
    provider: "openai",
    keyRef: { source: "env", provider: "default", id: "OPENAI_ROTATING_PREPARED_KEY" },
  });
  const params = {
    agentDir: "/tmp/openclaw-agent",
    authProfileId: "openai:work",
    authProfileStore,
  };
  vi.stubEnv("OPENAI_ROTATING_PREPARED_KEY", "first-prepared-key");
  const first = await authCacheKey(params);
  const handoff = await prepareHandoff({
    ...params,
    homeScope: "agent",
    requirePreparedAuth: true,
    subscriptionProfileRequiredError: "unused",
    subscriptionProfileUnusableError: "unused",
  });
  if (handoff.preparedAuth?.kind !== "profile" || !handoff.preparedAuth.snapshot) {
    throw new Error("Expected prepared remote profile");
  }
  expect(handoff.authProfileId).toBe("openai:work");
  expect(handoff.preparedAuth.snapshot).toEqual({
    loginParams: { type: "apiKey", apiKey: "first-prepared-key" },
    secretFreeCacheKey: `openai:work:${resolveCodexAppServerPreparedApiKeyCacheKey("first-prepared-key")}`,
  });
  vi.stubEnv("OPENAI_ROTATING_PREPARED_KEY", "second-prepared-key");
  const second = await authCacheKey(params);
  expect(first).toMatch(/^openai:work:api_key:sha256:[a-f0-9]{64}$/u);
  expect(second).toMatch(/^openai:work:api_key:sha256:[a-f0-9]{64}$/u);
  expect(second).not.toBe(first);
  expect(first).not.toContain("first-prepared-key");
  expect(second).not.toContain("second-prepared-key");
  const { request, apply } = authFixture(params.agentDir, authProfileStore, loginRequest("apiKey"));
  await apply({
    preparedAuth: { ...handoff.preparedAuth, snapshot: handoff.preparedAuth.snapshot },
  });
  expectApiKeyLogin(request, "first-prepared-key");
});

it.each(["JWT workspace", "email only", "conflicting workspace"] as const)(
  "validates the prepared OAuth identity: %s",
  async (identity) => {
    const credential = oauthProfile("test", {
      access:
        identity === "email only"
          ? "opaque-access-token"
          : chatgptAccessToken(
              identity === "JWT workspace" ? "account-from-jwt" : "workspace-from-token",
            ),
      refresh: "refresh-token",
      ...(identity === "conflicting workspace"
        ? { accountId: "workspace-from-profile" }
        : { email: "operator@example.test" }),
    });
    const snapshot = prepareSnapshot(
      profileParams("/tmp/openclaw-agent", profileStore(credential)),
    );
    if (identity === "JWT workspace") {
      await expect(snapshot).resolves.toMatchObject({
        loginParams: { type: "chatgptAuthTokens", chatgptAccountId: "account-from-jwt" },
        chatgptAccountId: "account-from-jwt",
      });
    } else {
      await expect(snapshot).rejects.toThrow(
        identity === "email only" ? "ChatGPT account ID" : "different ChatGPT account ID",
      );
    }
  },
);

it("does not borrow OS-home OAuth for isolated homes", async ({ agentDir: root }) => {
  const osHome = path.join(root, "os-home");
  const openClawHome = path.join(root, "openclaw-home");
  const agentDir = path.join(openClawHome, "agents", "main", "agent");
  const request = loginRequest();
  vi.stubEnv("HOME", osHome);
  vi.stubEnv("OPENCLAW_HOME", openClawHome);
  vi.stubEnv("CODEX_HOME", undefined);
  await writeCodexCliAuthFile(path.join(osHome, ".codex"));
  const nativeBefore = await fs.readFile(path.join(osHome, ".codex", "auth.json"));

  await applyAuth({
    client: { request } as never,
    agentDir,
  });

  expect(request).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(osHome, ".codex", "auth.json"))).toEqual(nativeBefore);
  await expectPathMissing(path.join(agentDir, "auth-profiles.json"));
});

it("rejects cached CLI OAuth refresh without a profile", async ({ agentDir: root }) => {
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(root, "codex-cli");
  vi.stubEnv("CODEX_HOME", codexHome);
  await writeCodexCliAuthFile(codexHome);
  const nativeBefore = await fs.readFile(path.join(codexHome, "auth.json"));

  await expect(authCacheKey({ agentDir })).resolves.toBeUndefined();
  await expect(
    refreshTokens({
      agentDir,
      authHandoff: authHandoff("fresh-cli-access-token", "account-cli"),
      previousAccountId: "account-cli",
    }),
  ).rejects.toThrow("requires an OAuth auth profile");

  expect(oauth.refresh).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(codexHome, "auth.json"))).toEqual(nativeBefore);
});

it("preserves native ChatGPT accounts over ambient keys", async ({ agentDir }) => {
  const request = vi.fn(async (method: string) => {
    if (method === "account/read") {
      return {
        account: { type: "chatgpt", email: "codex@example.test", planType: "plus" },
        requiresOpenaiAuth: true,
      };
    }
    return { type: "apiKey" };
  });
  vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");

  await applyApiKeyFallback(request, agentDir);

  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false }, expect.anything());
});

it("falls back to CLI API-key auth.json", async ({ agentDir: root }) => {
  const agentDir = path.join(root, "agent");
  const codexHome = path.join(root, "codex-cli");
  const request = fallbackRequest();
  vi.stubEnv("CODEX_HOME", codexHome);
  vi.stubEnv("CODEX_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");

  await writeCodexCliApiKeyAuthFile(codexHome);

  await applyAuth({
    client: { request } as never,
    agentDir,
    authRequirement: "api-key",
    startOptions: createStartOptions({
      env: { CODEX_HOME: path.join(root, "isolated-codex-home") },
    }),
  });

  expectApiKeyLogin(request, "cli-auth-json-api-key", true);
});

it("fingerprints fallback CLI API-key rotations", async ({ agentDir: root }) => {
  const codexHome = path.join(root, "codex-cli");

  await writeCodexCliApiKeyAuthFile(codexHome);

  const first = resolveCodexAppServerFallbackApiKeyCacheKey({
    startOptions: createStartOptions(),
    baseEnv: { CODEX_HOME: codexHome },
  });
  await writeCodexCliApiKeyAuthFile(codexHome, "second-cli-auth-json-api-key");
  const second = resolveCodexAppServerFallbackApiKeyCacheKey({
    startOptions: createStartOptions(),
    baseEnv: { CODEX_HOME: codexHome },
  });

  expect(first).toMatch(/^CODEX_AUTH_JSON:sha256:[a-f0-9]{64}$/);
  expect(second).toMatch(/^CODEX_AUTH_JSON:sha256:[a-f0-9]{64}$/);
  expect(second).not.toBe(first);
  expect(first).not.toContain("cli-auth-json-api-key");
  expect(second).not.toContain("second-cli-auth-json-api-key");
});

it("honors clearEnv before env API-key fallback", async ({ agentDir }) => {
  const request = fallbackRequest();
  vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
  vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
  vi.stubEnv("CODEX_HOME", path.join(agentDir, "empty-codex-home"));
  vi.stubEnv("HOME", path.join(agentDir, "empty-home"));

  await applyAuth({
    client: { request } as never,
    agentDir,
    authRequirement: "api-key",
    startOptions: createStartOptions({
      clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    }),
  });

  expect(request).not.toHaveBeenCalled();
});

it("never sends ambient keys to websocket servers", async ({ agentDir }) => {
  const request = fallbackRequest();
  vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
  vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");

  const codexHome = path.join(agentDir, "native-cli");
  await writeCodexCliApiKeyAuthFile(codexHome);
  vi.stubEnv("CODEX_HOME", codexHome);
  const startOptions = createStartOptions({
    transport: "websocket",
    url: "ws://127.0.0.1:1455",
    clearEnv: ["FOO"],
  });
  await expect(bridgeStart({ startOptions, agentDir })).resolves.toBe(startOptions);
  expect(
    resolveCodexAppServerFallbackApiKeyCacheKey({
      startOptions,
      baseEnv: { CODEX_HOME: codexHome },
    }),
  ).toBeUndefined();
  await applyApiKeyFallback(request, agentDir, startOptions);

  expect(request).not.toHaveBeenCalled();
});

it("rejects retired auth-provider profiles before login", async ({ agentDir }) => {
  const { request, apply, cache, snapshot } = authFixture(agentDir, undefined);

  persistProfile(agentDir, {
    type: "token",
    provider: "openai-codex",
    token: "legacy-access-token",
    email: "legacy-codex@example.test",
  });

  const rejection = await apply().catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toMatchObject({
    code: "selected_auth_profile_unavailable",
    message:
      'Codex app-server auth profile "openai:work" must use the OpenAI auth provider; run "openclaw doctor --fix" to migrate legacy provider IDs.',
  });
  expect(rejection).not.toHaveProperty("status");
  await expect(cache()).resolves.toBeUndefined();
  await expect(snapshot()).resolves.toBeUndefined();
  expect(oauth.refresh).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("rejects callback workspace changes before refresh", async ({ agentDir }) => {
  persistProfile(
    agentDir,
    oauthProfile("test", {
      access: chatgptAccessToken("workspace-selected"),
      refresh: "workspace-refresh-token",
    }),
  );

  await expect(
    refreshTokens({
      ...profileParams(agentDir),
      previousAccountId: "workspace-original",
    }),
  ).rejects.toThrow(/ChatGPT workspace changed.*[Rr]etry/);
  expect(oauth.refresh).not.toHaveBeenCalled();
});

it("refreshes the owner instead of a stale child clone", async ({ agentDir: root }) => {
  const stateDir = path.join(root, "state");
  const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  oauth.refresh.mockResolvedValueOnce(
    oauthTokens("test", {
      access: "main-refreshed-access-token",
      refresh: "main-refreshed-refresh-token",
      accountId: "account-main",
    }),
  );

  await fs.mkdir(childAgentDir, { recursive: true });
  await upsertAuthProfileAsync({
    agentDir: childAgentDir,
    profileId: "openai:work",
    credential: oauthProfile("test", {
      access: "child-stale-access-token",
      refresh: "child-stale-refresh-token",
      expires: Date.now() - 60_000,
      accountId: "account-main",
      email: "main-codex@example.test",
    }),
  });
  await upsertAuthProfileAsync({
    profileId: "openai:work",
    credential: oauthProfile("test", {
      access: "main-current-access-token",
      refresh: "main-owner-refresh-token",
      accountId: "account-main",
      email: "main-codex@example.test",
    }),
  });
  const staleChildProfile = readProfile(childAgentDir);
  expect(staleChildProfile).toMatchObject({
    type: "oauth",
    access: "child-stale-access-token",
    refresh: "child-stale-refresh-token",
  });

  await expect(
    refreshTokens({
      agentDir: childAgentDir,
      authProfileId: "openai:work",
    }),
  ).resolves.toEqual(refreshResult("main-refreshed-access-token", "account-main"));

  expect(oauth.refresh).toHaveBeenCalledWith("main-owner-refresh-token");
  const mainProfile = readProfile();
  expect(mainProfile).toMatchObject({
    type: "oauth",
    provider: "openai",
    access: "main-refreshed-access-token",
    refresh: "main-refreshed-refresh-token",
  });
  const childProfile = readProfile(childAgentDir);
  // Refresh ownership writes the main profile; it does not silently mutate
  // the stale child clone that request-time resolution intentionally bypassed.
  expect(childProfile).toMatchObject({
    type: "oauth",
    access: "child-stale-access-token",
    refresh: "child-stale-refresh-token",
  });
}); /* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
