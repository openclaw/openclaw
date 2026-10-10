import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it as baseIt, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile as applyAuth,
  bridgeCodexAppServerStartOptions as bridgeStart,
  refreshCodexAppServerAuthTokens as refreshTokens,
  reconcileCodexComputerUseStartArtifacts as reconcileArtifacts,
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
import type { CodexAppServerStartOptions } from "./config.js";
import type { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import { createClientHarness } from "./test-support.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

function it(name: string, run: (context: { agentDir: string }) => Promise<void>) {
  baseIt(name, () => withTempDir("openclaw-codex-", (agentDir) => run({ agentDir })));
}

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
  service: vi.fn<
    (_params?: unknown) => Promise<{
      status: "already_current" | "source_missing";
      changed: boolean;
    }>
  >(async () => ({ status: "already_current", changed: false })),
  marketplaceSource: vi.fn<
    (params: {
      candidates?: readonly MockDesktopCandidate[];
    }) => Promise<MockDesktopCandidate | undefined>
  >(async (params) => params.candidates?.[0]),
  serviceSource: vi.fn<
    (params: { sourceAppCandidates?: readonly string[] }) => Promise<string | undefined>
  >(async (params) => params.sourceAppCandidates?.[0]),
}));

const providerRuntimeMocks = vi.hoisted(() => ({
  formatProviderAuthProfileApiKeyWithPlugin: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(
    async (params: { provider?: string; context: { refresh: string } }) => {
      const refreshed = await oauth.refresh(params.context.refresh);
      return refreshed
        ? {
            ...params.context,
            ...refreshed,
            type: "oauth",
            provider: "openai",
          }
        : undefined;
    },
  ),
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
      if (credential.type === "api_key") {
        const apiKey =
          credential.key?.trim() ||
          (credential.keyRef?.source === "env" ? process.env[credential.keyRef.id]?.trim() : "");
        return apiKey ? { apiKey, provider: credential.provider } : null;
      }
      if (credential.type === "token") {
        const apiKey =
          credential.token?.trim() ||
          (credential.tokenRef?.source === "env"
            ? process.env[credential.tokenRef.id]?.trim()
            : "");
        return apiKey ? { apiKey, provider: credential.provider, email: credential.email } : null;
      }
      if (credential.type !== "oauth") {
        return null;
      }
      let oauthCredential = credential;
      if (params.forceRefresh || (oauthCredential.expires ?? 0) <= Date.now()) {
        const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
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
      const formatted = await providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin({
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
      const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
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
  providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin.mockReset();
  providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin.mockClear();
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

const EPHEMERAL_AUTH_ARGS = ["-c", 'cli_auth_credentials_store="ephemeral"', "app-server"];

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

type AuthProfileStore = ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>;
type AuthProfileCredential = AuthProfileStore["profiles"][string];

type OAuthProfile = Extract<AuthProfileCredential, { type: "oauth" }>;

function oauthProfile(
  prefix: string,
  overrides: Partial<Omit<OAuthProfile, "type" | "provider">> = {},
): OAuthProfile {
  return {
    type: "oauth",
    provider: "openai",
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    // Fresh fixtures must outlive the proactive OAuth refresh window.
    expires: Date.now() + 24 * 60 * 60_000,
    ...overrides,
  };
}

function profileStore<T extends AuthProfileCredential>(credential: T) {
  return { version: 1, profiles: { "openai:work": credential } };
}

function profileParams(agentDir: string, authProfileStore?: AuthProfileStore) {
  return { agentDir, authProfileId: "openai:work", authProfileStore };
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
  const options = { assertCurrent: undefined };
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
    { assertCurrent: undefined },
  ];
  if (count === undefined) {
    expect(request).toHaveBeenCalledWith(...call);
  } else {
    expect(request.mock.calls).toEqual(Array.from({ length: count }, () => call));
  }
}

function expectOAuthProfile(
  profile: AuthProfileCredential | undefined,
): Extract<AuthProfileCredential, { type: "oauth" }> {
  if (!profile || profile.type !== "oauth") {
    throw new Error("Expected OAuth auth profile");
  }
  return profile;
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

async function writeCodexCliAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({
      tokens: {
        access_token: "cli-access-token",
        refresh_token: "cli-refresh-token",
        account_id: "account-cli",
      },
    })}\n`,
  );
}

async function writeCodexCliApiKeyAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "cli-auth-json-api-key",
    })}\n`,
  );
}

describe("Codex auth bridge", () => {
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
      args: EPHEMERAL_AUTH_ARGS,
      env: { CODEX_HOME: codexHomeDir(agentDir) },
    });

    const request = vi.fn(async (method: string) =>
      method === "account/read" ? { account: null, requiresOpenaiAuth: true } : { type: "apiKey" },
    );
    await applyAuth({
      client: { request } as never,
      agentDir,
      authRequirement: "api-key",
      startOptions,
    });
    expectApiKeyLogin(request, "platform-api-key", true);
  });

  baseIt("rejects a desktop candidate whose exact marketplace is unavailable", async () => {
    await withTempDir("openclaw-codex-", async (agentDir) => {
      desktop.marketplaceSource.mockResolvedValueOnce(undefined);

      await expect(
        reconcileArtifacts({
          startOptions: createStartOptions({
            command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          }),
          agentDir,
          pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        }),
      ).rejects.toMatchObject({
        code: "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE",
      });
      expect(desktop.service).not.toHaveBeenCalled();
      expect(desktop.marketplace).not.toHaveBeenCalled();
    });
  });

  baseIt.each([
    { marketplaceSource: "file:///tmp/custom-marketplace" },
    { marketplacePath: "/tmp/custom-marketplace/marketplace.json" },
    { marketplaceName: "custom-marketplace" },
  ])("keeps an exact desktop candidate with configured marketplace selection", async (selector) => {
    await withTempDir("openclaw-codex-computer-use-custom-source-", async (agentDir) => {
      await expect(
        reconcileArtifacts({
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
    });
  });

  it("classifies native client provisioning failures as harness preflight", async () => {
    desktop.marketplace.mockResolvedValueOnce("/managed/openai-bundled");
    desktop.service.mockRejectedValueOnce(new Error("copy failed"));

    await expect(
      reconcileArtifacts({
        startOptions: createStartOptions(),
        agentDir: "/tmp/openclaw-codex-computer-use-failed",
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      }),
    ).rejects.toMatchObject({ name: "AgentHarnessPreflightError", scope: "harness" });
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

    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
    });
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
    });
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig,
      desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
    });

    expect(desktop.cache.mock.calls.map(([params]) => params.forceRefresh)).toEqual([
      true,
      false,
      true,
    ]);
    expect(desktop.service).not.toHaveBeenCalled();
    expect(desktop.marketplace).not.toHaveBeenCalled();
  });

  it("does not let a stale desktop generation publish artifacts after its successor", async ({
    agentDir,
  }) => {
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
    let currentEpoch = 1;
    const startOptions = createStartOptions();
    const first = reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
      assertCurrent: () => {
        if (currentEpoch !== 1) {
          throw new Error("desktop generation X is stale");
        }
      },
    });
    await firstMarketplaceStarted.promise;
    currentEpoch = 2;
    const second = reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
      assertCurrent: () => {
        if (currentEpoch !== 2) {
          throw new Error("desktop generation Y is stale");
        }
      },
    });
    releaseFirstMarketplace.resolve();

    await expect(first).rejects.toThrow("desktop generation X is stale");
    await expect(second).resolves.toBeUndefined();
    expect(maxActiveMarketplaceCalls).toBe(1);
    expect(desktop.service).toHaveBeenCalledTimes(1);
  });

  it("uses the native user Codex home for coexistence mode", async ({ agentDir: root }) => {
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "user-codex-home");
    vi.stubEnv("CODEX_HOME", codexHome);
    const startOptions = createStartOptions({ homeScope: "user" });
    await expect(bridgeStart({ startOptions, agentDir, authProfileId: null })).resolves.toEqual({
      ...startOptions,
      env: { CODEX_HOME: codexHome },
    });
    await expect(fs.access(codexHome)).resolves.toBeUndefined();
    await expectPathMissing(codexHomeDir(agentDir));
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    });
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
      args: EPHEMERAL_AUTH_ARGS,
      env: {
        CODEX_HOME: codexHome,
        HOME: nativeHome,
        EXISTING: "1",
      },
      clearEnv: ["FOO"],
    });
    await expect(fs.access(codexHome)).resolves.toBeUndefined();
    await expect(fs.access(nativeHome)).resolves.toBeUndefined();
    expect(startOptions.clearEnv).toEqual(["CODEX_HOME", "HOME", "FOO"]);
    await reconcileArtifacts({
      startOptions,
      agentDir,
      pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
    });
    expect(desktop.service).not.toHaveBeenCalled();
    expect(desktop.marketplace).not.toHaveBeenCalled();
  });

  it("clears inherited API-key env vars when the default Codex profile is subscription auth", async ({
    agentDir,
  }) => {
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
      args: EPHEMERAL_AUTH_ARGS,
      env: {
        EXISTING: "1",
        CODEX_HOME: codexHomeDir(agentDir),
      },
      clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY"],
    });
    expect(startOptions.clearEnv).toEqual(["CODEX_HOME", "HOME", "FOO"]);
    await expectPathMissing(path.join(agentDir, "harness-auth"));
  });

  baseIt.each(["api-key", "profile"] as const)(
    "clears ambient auth before prepared %s startup",
    async (authKind) => {
      await withTempDir("openclaw-codex-", async (agentDir) => {
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
          args: EPHEMERAL_AUTH_ARGS,
          env: { CODEX_HOME: codexHomeDir(agentDir) },
          clearEnv: ["FOO", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
        });
        const spawnEnv = resolveCodexAppServerSpawnEnv(bridged, {
          FOO: "ambient",
          CODEX_API_KEY: "ambient-codex-key",
          OPENAI_API_KEY: "ambient-openai-key",
          CODEX_ACCESS_TOKEN: "ambient-access-token",
        });
        expect(spawnEnv).toMatchObject({ CODEX_HOME: codexHomeDir(agentDir) });
        expect(spawnEnv).not.toHaveProperty("FOO");
        expect(spawnEnv).not.toHaveProperty("CODEX_API_KEY");
        expect(spawnEnv).not.toHaveProperty("OPENAI_API_KEY");
        expect(spawnEnv).not.toHaveProperty("CODEX_ACCESS_TOKEN");
      });
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
    const request = vi.fn(async () => ({ type: "apiKey" }));
    await applyAuth({
      client: { request } as never,
      agentDir: "/tmp/openclaw-agent",
      authProfileId: null,
      authProfileStore,
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

  it("keeps an inherited OpenAI API key for an explicit Codex api-key profile", async ({
    agentDir,
  }) => {
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
      args: EPHEMERAL_AUTH_ARGS,
      env: {
        CODEX_HOME: codexHomeDir(agentDir),
      },
    });
    const request = vi.fn(async () => ({ type: "apiKey" }));
    await expect(
      applyAuth({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
      }),
    ).resolves.toBeUndefined();
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

  baseIt.each(["credential refresh", "overload retry"] as const)(
    "does not send native login after its caller retires during %s",
    async (phase) => {
      await withTempDir("openclaw-codex-retired-auth-", async (agentDir) => {
        const refreshing = createDeferred<void>();
        const release = createDeferred<void>();
        oauth.refresh.mockImplementationOnce(async () => {
          refreshing.resolve();
          await release.promise;
          return {
            access: chatgptAccessToken("scoped-account"),
            refresh: "refreshed-token",
            expires: Date.now() + 60_000,
            accountId: "scoped-account",
          };
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
        const authProfileStore: AuthProfileStore = profileStore(
          oauthProfile("test", {
            access: "expired-access",
            refresh: "refresh-token",
            expires: Date.now() - 60_000,
            accountId: "scoped-account",
          }),
        );
        const params = {
          client: harness.client,
          ...profileParams(agentDir, authProfileStore),
          assertCurrent: () => {
            if (!current) {
              throw retired;
            }
          },
        };
        const run = applyAuth(params);
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
      });
    },
  );

  it("does not record native login auth after post-response lifecycle retirement", async ({
    agentDir,
  }) => {
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as { id?: string | number };
        if (message.id !== undefined) {
          send({ id: message.id, result: { type: "chatgptAuthTokens" } });
        }
      },
    });
    let checks = 0;
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
        applyAuth({
          client: harness.client,
          ...profileParams(agentDir),
          assertCurrent: () => {
            checks += 1;
            if (checks > 2) {
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

  it("keeps prepared persisted auth aligned across forced refresh-token rotations", async ({
    agentDir,
  }) => {
    const credential = oauthProfile("test", {
      access: "initial-access",
      refresh: "initial-refresh",
      expires: Date.now() + 60 * 60_000,
      accountId: "rotating-account",
    });
    persistProfile(agentDir, credential);
    const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
    const currentCredential = {
      ...credential,
      refresh: "updated-refresh",
      expires: credential.expires + 60_000,
    };
    persistProfile(agentDir, currentCredential);
    oauth.refresh
      .mockImplementationOnce(async () => {
        expect(readProfile(agentDir)).toEqual(currentCredential);
        return {
          access: "first-rotated-access",
          refresh: "first-rotated-refresh",
          expires: Date.now() + 60_000,
        };
      })
      .mockResolvedValueOnce({
        access: "second-rotated-access",
        refresh: "second-rotated-refresh",
        expires: Date.now() + 60_000,
      });
    const params = { agentDir, authProfileId: "openai:work", authProfileStore };
    const first = await refreshTokens({
      ...params,
      previousAccountId: "rotating-account",
      authHandoff: {
        accessFingerprint: fingerprintTokenAuthProfileCacheKey(credential.access),
        chatgptAccountId: "rotating-account",
      },
    });
    expect(first).toEqual({
      accessToken: "first-rotated-access",
      chatgptAccountId: "rotating-account",
      chatgptPlanType: null,
    });
    const second = await refreshTokens(params);
    expect(second.accessToken).toBe("second-rotated-access");
    expect(oauth.refresh.mock.calls).toEqual([["updated-refresh"], ["first-rotated-refresh"]]);
    expect(authProfileStore.profiles["openai:work"]).toMatchObject({
      access: "second-rotated-access",
      refresh: "second-rotated-refresh",
    });
    expect(readProfile(agentDir)).toMatchObject({
      access: "second-rotated-access",
      refresh: "second-rotated-refresh",
    });
  });

  it("reuses a late persisted access rotation on the next physical-client callback", async ({
    agentDir,
  }) => {
    vi.useFakeTimers();
    const lateRefresh = createDeferred<{
      access: string;
      refresh: string;
      expires: number;
      accountId: string;
    }>();
    const refreshStarted = createDeferred<void>();
    oauth.refresh
      .mockImplementationOnce(() => {
        refreshStarted.resolve();
        return lateRefresh.promise;
      })
      .mockResolvedValueOnce({
        access: "duplicate-access",
        refresh: "duplicate-refresh",
        expires: Date.now() + 60_000,
        accountId: "account-a",
      });
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const message = JSON.parse(line) as { id?: string | number; method?: string };
        if (message.method === "account/login/start" && message.id !== undefined) {
          send({ id: message.id, result: { type: "chatgptAuthTokens" } });
        }
      },
    });
    try {
      persistProfile(agentDir, oauthProfile("initial", { accountId: "account-a" }));
      const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
      ensureCodexAppServerClientRuntime(harness.client, profileParams(agentDir, authProfileStore));
      recordCodexAppServerAuthHandoff(
        harness.client,
        await applyAuth({
          client: harness.client,
          ...profileParams(agentDir, authProfileStore),
        }),
      );

      harness.send({
        id: "refresh-timeout",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: "account-a" },
      });
      await refreshStarted.promise;
      await vi.advanceTimersByTimeAsync(9_000);
      expect(JSON.parse(await harness.waitForWrite(1))).toMatchObject({
        id: "refresh-timeout",
        error: { message: expect.stringContaining("token refresh timed out") },
      });

      lateRefresh.resolve({
        access: "late-access",
        refresh: "late-refresh",
        expires: Date.now() + 24 * 60 * 60_000,
        accountId: "account-a",
      });
      await vi.waitFor(() =>
        expect(authProfileStore.profiles["openai:work"]).toMatchObject({
          access: "late-access",
          refresh: "late-refresh",
        }),
      );

      harness.send({
        id: "refresh-retry",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: "account-a" },
      });
      expect(JSON.parse(await harness.waitForWrite(2))).toEqual({
        id: "refresh-retry",
        result: {
          accessToken: "late-access",
          chatgptAccountId: "account-a",
          chatgptPlanType: null,
        },
      });
      expect(oauth.refresh).toHaveBeenCalledTimes(1);

      harness.send({
        id: "refresh-after-handoff",
        method: "account/chatgptAuthTokens/refresh",
        params: { reason: "unauthorized", previousAccountId: "account-a" },
      });
      expect(JSON.parse(await harness.waitForWrite(3))).toEqual({
        id: "refresh-after-handoff",
        result: {
          accessToken: "duplicate-access",
          chatgptAccountId: "account-a",
          chatgptPlanType: null,
        },
      });
      expect(oauth.refresh).toHaveBeenCalledTimes(2);
    } finally {
      harness.client.close();
      vi.useRealTimers();
    }
  });

  it("does not commit a different workspace from a forced scoped refresh", async ({ agentDir }) => {
    const credential = oauthProfile("initial", { accountId: "account-a" });
    const authProfileStore: AuthProfileStore = profileStore(credential);
    oauth.refresh.mockResolvedValueOnce({
      access: "other-access",
      refresh: "other-refresh",
      expires: Date.now() + 24 * 60 * 60_000,
      accountId: "account-b",
    });

    await expect(
      refreshTokens({
        ...profileParams(agentDir, authProfileStore),
        authHandoff: authHandoff(credential.access, "account-a"),
        previousAccountId: "account-a",
      }),
    ).rejects.toThrow("ChatGPT workspace changed during Codex token refresh");
    expect(authProfileStore.profiles["openai:work"]).toEqual(credential);
  });

  it("does not persist a different workspace from a forced owner refresh", async ({ agentDir }) => {
    const credential = oauthProfile("initial", {
      access: chatgptAccessToken("account-a"),
      expires: Date.now() + 60 * 60_000,
    });
    oauth.refresh.mockResolvedValueOnce({
      access: chatgptAccessToken("account-b"),
      refresh: "other-refresh",
      expires: Date.now() + 24 * 60 * 60_000,
      accountId: "account-b",
    });

    persistProfile(agentDir, credential);
    const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);

    await expect(
      refreshTokens({
        ...profileParams(agentDir, authProfileStore),
        authHandoff: authHandoff(credential.access, "account-a"),
        previousAccountId: "account-a",
      }),
    ).rejects.toThrow("ChatGPT workspace changed during Codex token refresh");
    expect(readProfile(agentDir)).toEqual(credential);
  });

  it("rejects conflicting callback workspace identities before refreshing", async ({
    agentDir,
  }) => {
    const credential = oauthProfile("opaque", { expires: Date.now() + 60 * 60_000 });
    const authProfileStore: AuthProfileStore = profileStore(credential);

    await expect(
      refreshTokens({
        ...profileParams(agentDir, authProfileStore),
        authHandoff: authHandoff(credential.access, "account-a"),
        previousAccountId: "account-b",
      }),
    ).rejects.toThrow("ChatGPT workspace changed before Codex token refresh");
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(authProfileStore.profiles["openai:work"]).toEqual(credential);
  });

  it("does not let a stale client refresh a newly selected scoped workspace", async ({
    agentDir,
  }) => {
    const credential = oauthProfile("workspace-b", { accountId: "account-b" });
    const authProfileStore: AuthProfileStore = profileStore(credential);

    await expect(
      refreshTokens({
        ...profileParams(agentDir, authProfileStore),
        authHandoff: authHandoff("workspace-a-access", "account-a"),
      }),
    ).rejects.toThrow("ChatGPT workspace changed before Codex token refresh");
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(authProfileStore.profiles["openai:work"]).toEqual(credential);
  });

  it("does not replace a prepared persisted store changed during refresh", async ({ agentDir }) => {
    let resolveRefresh:
      | ((value: { access: string; refresh: string; expires: number }) => void)
      | undefined;
    oauth.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    persistProfile(agentDir, oauthProfile("initial", { accountId: "initial-account" }));
    const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);

    const refresh = refreshTokens(profileParams(agentDir, authProfileStore));
    await vi.waitFor(() => expect(oauth.refresh).toHaveBeenCalledTimes(1));
    authProfileStore.profiles["openai:work"] = oauthProfile("replacement", {
      accountId: "replacement-account",
    });
    resolveRefresh?.({
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 60_000,
    });

    await refresh;
    expect(authProfileStore.profiles["openai:work"]).toMatchObject({
      access: "replacement-access",
      refresh: "replacement-refresh",
      accountId: "replacement-account",
    });
  });

  it("returns the validated refresh generation across a concurrent persisted workspace switch", async ({
    agentDir,
  }) => {
    const initialAccess = chatgptAccessToken("workspace-a", "initial");
    const refreshedAccess = chatgptAccessToken("workspace-a", "refreshed");
    const replacementAccess = chatgptAccessToken("workspace-b", "replacement");
    oauth.refresh.mockResolvedValueOnce({
      access: refreshedAccess,
      refresh: "refreshed-refresh",
      expires: Date.now() + 60_000,
    });
    providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin.mockImplementationOnce(
      async ({ context }) => {
        persistProfile(
          agentDir,
          oauthProfile("replacement", { access: replacementAccess, expires: Date.now() + 60_000 }),
        );
        return context.access;
      },
    );

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
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauth.refresh.mockResolvedValueOnce({
      access: "scoped-refreshed-access",
      refresh: "scoped-refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "shared-account",
    });

    persistProfile(agentDir, oauthProfile("persisted", { accountId: "shared-account" }));
    const scopedCredential = {
      ...oauthProfile("scoped", {
        access: "scoped-expired-access",
        expires: Date.now() - 60_000,
        accountId: "shared-account",
      }),
      chatgptPlanType: "pro",
    };
    const authProfileStore: AuthProfileStore = {
      version: 1,
      runtimeExternalProfileIds: ["openai:work"],
      runtimeExternalProfileIdsAuthoritative: true,
      profiles: {
        "openai:work": scopedCredential,
      },
    };

    await applyAuth({
      client: { request } as never,
      ...profileParams(agentDir, authProfileStore),
    });

    expect(oauth.refresh).toHaveBeenCalledWith("scoped-refresh");
    expectTokenLogin(request, "scoped-refreshed-access", "shared-account", "pro");
    expect(readProfile(agentDir)).toMatchObject({
      access: "persisted-access",
      refresh: "persisted-refresh",
      accountId: "shared-account",
    });
  });

  it("keeps changed-workspace clones scoped even when emails match", async ({ agentDir }) => {
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    const refreshedAccess = chatgptAccessToken("account-a", "refreshed");
    const replacementAccess = chatgptAccessToken("account-b");
    oauth.refresh.mockResolvedValueOnce({
      access: refreshedAccess,
      refresh: "account-a-refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "account-a",
    });

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

    await applyAuth({
      client: { request } as never,
      ...profileParams(agentDir, authProfileStore),
    });

    expect(oauth.refresh).toHaveBeenCalledWith("account-a-refresh");
    expectTokenLogin(request, refreshedAccess, "account-a");
    expect(readProfile(agentDir)).toMatchObject({
      access: replacementAccess,
      refresh: "account-b-refresh",
    });
  });

  it("coalesces scoped startup logins and validates each refresh waiter", async ({ agentDir }) => {
    const refresh = createDeferred<{
      access: string;
      refresh: string;
      expires: number;
      accountId: string;
    }>();
    const started = createDeferred<void>();
    oauth.refresh.mockImplementationOnce(() => {
      started.resolve();
      return refresh.promise;
    });
    const credential = oauthProfile("expired", { expires: Date.now() - 60_000 });
    const authProfileStore: AuthProfileStore = profileStore(credential);

    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    const params = { client: { request } as never, ...profileParams(agentDir, authProfileStore) };
    const first = applyAuth(params);
    const second = applyAuth(params);
    const compatibleWaiter = refreshTokens({
      agentDir,
      authProfileId: "openai:work",
      authProfileStore,
      previousAccountId: "account-a",
    });
    const incompatibleWaiter = refreshTokens({
      ...profileParams(agentDir, authProfileStore),
      authHandoff: authHandoff(credential.access, "account-b"),
    });
    await started.promise;

    refresh.resolve({
      access: "refreshed-access",
      refresh: "refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "account-a",
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      authHandoff("refreshed-access", "account-a"),
      authHandoff("refreshed-access", "account-a"),
    ]);
    expectTokenLogin(request, "refreshed-access", "account-a", null, 2);
    await expect(compatibleWaiter).resolves.toEqual({
      accessToken: "refreshed-access",
      chatgptAccountId: "account-a",
      chatgptPlanType: null,
    });
    await expect(incompatibleWaiter).rejects.toThrow(
      "ChatGPT workspace changed during Codex token refresh",
    );
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves native app-server auth untouched when auth bridging is disabled", async ({
    agentDir,
  }) => {
    const request = vi.fn(async () => ({ requiresOpenaiAuth: true }));

    vi.stubEnv("OPENAI_API_KEY", "env-api-key");

    await applyAuth({
      client: { request } as never,
      agentDir,
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
    const request = vi.fn(async () => ({ type: "apiKey" }));
    await applyAuth({
      ...params,
      client: { request } as never,
      preparedAuth: { ...handoff.preparedAuth, snapshot: handoff.preparedAuth.snapshot },
    });
    expectApiKeyLogin(request, "first-prepared-key");
  });

  it("derives a missing ChatGPT account id from the access-token workspace claim", async () => {
    const access = chatgptAccessToken("account-from-jwt");

    const snapshot = await prepareSnapshot({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:work",
      authProfileStore: profileStore(
        oauthProfile("test", { access, refresh: "refresh-token", email: "operator@example.test" }),
      ),
    });

    expect(snapshot).toMatchObject({
      loginParams: { type: "chatgptAuthTokens", chatgptAccountId: "account-from-jwt" },
      chatgptAccountId: "account-from-jwt",
    });
  });

  it("rejects an email-only OAuth profile instead of inventing a workspace identity", async () => {
    await expect(
      prepareSnapshot({
        agentDir: "/tmp/openclaw-agent",
        authProfileId: "openai:work",
        authProfileStore: profileStore(
          oauthProfile("test", {
            access: "opaque-access-token",
            refresh: "refresh-token",
            email: "operator@example.test",
          }),
        ),
      }),
    ).rejects.toThrow("ChatGPT account ID");
  });

  it("rejects a stored workspace that contradicts the access-token identity", async () => {
    await expect(
      prepareSnapshot({
        agentDir: "/tmp/openclaw-agent",
        authProfileId: "openai:work",
        authProfileStore: profileStore(
          oauthProfile("test", {
            access: chatgptAccessToken("workspace-from-token"),
            refresh: "refresh-token",
            accountId: "workspace-from-profile",
          }),
        ),
      }),
    ).rejects.toThrow("different ChatGPT account ID");
  });

  it("does not borrow OS-home native OAuth for an isolated OpenClaw home", async ({
    agentDir: root,
  }) => {
    const osHome = path.join(root, "os-home");
    const openClawHome = path.join(root, "openclaw-home");
    const agentDir = path.join(openClawHome, "agents", "main", "agent");
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
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

  it("does not let a cached handoff refresh native CLI OAuth without a profile", async ({
    agentDir: root,
  }) => {
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

  it("keeps an existing app-server ChatGPT account over env API-key fallback", async ({
    agentDir,
  }) => {
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

    await applyAuth({
      client: { request } as never,
      agentDir,
      authRequirement: "api-key",
      startOptions: createStartOptions(),
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "account/read",
      { refreshToken: false },
      { assertCurrent: undefined },
    );
  });

  it("uses Codex CLI api-key auth.json when no auth profile or env key exists", async ({
    agentDir: root,
  }) => {
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
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

  it("includes Codex CLI api-key auth.json in fallback app-server cache keys", async ({
    agentDir: root,
  }) => {
    const codexHome = path.join(root, "codex-cli");

    await writeCodexCliApiKeyAuthFile(codexHome);

    const first = resolveCodexAppServerFallbackApiKeyCacheKey({
      startOptions: createStartOptions(),
      baseEnv: { CODEX_HOME: codexHome },
    });
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      `${JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "second-cli-auth-json-api-key",
      })}\n`,
    );
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
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
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

  it("does not send env API-key fallback to websocket app-server connections", async ({
    agentDir,
  }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
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
    await applyAuth({
      client: { request } as never,
      agentDir,
      authRequirement: "api-key",
      startOptions,
    });

    expect(request).not.toHaveBeenCalled();
  });

  it("rejects retired openai-codex auth-provider profiles before app-server login", async ({
    agentDir,
  }) => {
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));

    persistProfile(agentDir, {
      type: "token",
      provider: "openai-codex",
      token: "legacy-access-token",
      email: "legacy-codex@example.test",
    });

    const rejection = await applyAuth({
      client: { request } as never,
      ...profileParams(agentDir),
    }).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).toMatchObject({
      code: "selected_auth_profile_unavailable",
      message:
        'Codex app-server auth profile "openai:work" must use the canonical OpenAI auth provider; run "openclaw doctor --fix" to migrate legacy provider IDs.',
    });
    expect(rejection).not.toHaveProperty("status");
    await expect(authCacheKey(profileParams(agentDir))).resolves.toBeUndefined();
    await expect(prepareSnapshot(profileParams(agentDir))).resolves.toBeUndefined();
    expect(oauth.refresh).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects callback workspace changes against token claims before refresh", async ({
    agentDir,
  }) => {
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

  it("force-refreshes the owner credential instead of a stale child OAuth clone", async ({
    agentDir: root,
  }) => {
    const stateDir = path.join(root, "state");
    const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    oauth.refresh.mockResolvedValueOnce({
      access: "main-refreshed-access-token",
      refresh: "main-refreshed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-main",
    });

    await fs.mkdir(childAgentDir, { recursive: true });
    persistProfile(
      childAgentDir,
      oauthProfile("test", {
        access: "child-stale-access-token",
        refresh: "child-stale-refresh-token",
        expires: Date.now() - 60_000,
        accountId: "account-main",
        email: "main-codex@example.test",
      }),
    );
    upsertAuthProfile({
      profileId: "openai:work",
      credential: oauthProfile("test", {
        access: "main-current-access-token",
        refresh: "main-owner-refresh-token",
        accountId: "account-main",
        email: "main-codex@example.test",
      }),
    });
    const staleChildProfile = expectOAuthProfile(readProfile(childAgentDir));
    expect(staleChildProfile?.access).toBe("child-stale-access-token");
    expect(staleChildProfile?.refresh).toBe("child-stale-refresh-token");

    await expect(
      refreshTokens({
        agentDir: childAgentDir,
        authProfileId: "openai:work",
      }),
    ).resolves.toEqual({
      accessToken: "main-refreshed-access-token",
      chatgptAccountId: "account-main",
      chatgptPlanType: null,
    });

    expect(oauth.refresh).toHaveBeenCalledWith("main-owner-refresh-token");
    const mainProfile = expectOAuthProfile(readProfile());
    expect(mainProfile?.provider).toBe("openai");
    expect(mainProfile?.access).toBe("main-refreshed-access-token");
    expect(mainProfile?.refresh).toBe("main-refreshed-refresh-token");
    const childProfile = expectOAuthProfile(readProfile(childAgentDir));
    // Refresh ownership writes the main profile; it does not silently mutate
    // the stale child clone that request-time resolution intentionally bypassed.
    expect(childProfile?.access).toBe("child-stale-access-token");
    expect(childProfile?.refresh).toBe("child-stale-refresh-token");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
